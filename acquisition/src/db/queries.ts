// D1 data layer.
//
// Two invariants this module exists to enforce:
//
//  1. `companies` is keyed on the registrable domain, and upserts are
//     idempotent. Discovery will find the same company repeatedly through
//     different routes; that must converge on one row, not create duplicates.
//
//  2. Facts, products and scores are APPEND-ONLY. Nothing here updates them.
//     Writers add a row tagged with a run id; readers go through the
//     `current_*` views. That is what makes a score movement explainable —
//     you can always tell whether the company changed or the model did.
//
// Time is always passed in as an epoch-ms argument rather than read from the
// clock inside, so every function is deterministic under test.

/**
 * The slice of D1 this module uses. Terminals are available both directly on a
 * prepared statement and after bind(), mirroring the real D1 API.
 */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

export type CompanyStatus =
  | "discovered" | "crawling" | "crawled" | "scored" | "contactable"
  | "contacted" | "replied" | "converted" | "rejected" | "suppressed";

export type SourceKind =
  | "seed" | "search_query" | "link_graph" | "directory" | "manual" | "referral";

export type PageKind = "home" | "sitemap" | "product" | "about" | "contact" | "other";

export interface CompanyRow {
  id: string;
  domain: string;
  name: string | null;
  country: string | null;
  region: string | null;
  seller_type: string | null;
  status: CompanyStatus;
  converted_vendor_id: string | null;
  suppressed_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface CrawlJobRow {
  id: string;
  company_id: string;
  status: "queued" | "running" | "done" | "failed" | "blocked";
  attempts: number;
  robots_allowed: number | null;
  robots_checked_at: number | null;
  crawl_delay_ms: number | null;
  next_eligible_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const newId = () => crypto.randomUUID();

/**
 * Reduce any URL or host string to the dedupe key: lowercase host, no scheme,
 * no `www.`, no port, no path. Returns null for anything that is not a usable
 * domain, so junk never becomes a company row.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;

  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    value = value.split("/")[0]!;
  }

  value = value.split("@").pop()!;   // tolerate an email-ish input
  value = value.split(":")[0]!;      // strip port
  value = value.replace(/^www\./, "").replace(/\.$/, "");

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return null;
  if (value.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) {
    return null;
  }
  return value;
}

/** Idempotent on domain. Only fills fields that are currently null. */
export async function upsertCompany(
  db: Db,
  input: { domain: string; name?: string | null; country?: string | null; region?: string | null; sellerType?: string | null },
  now: number
): Promise<CompanyRow | null> {
  const domain = normalizeDomain(input.domain);
  if (!domain) return null;

  return db
    .prepare(
      `insert into companies (id, domain, name, country, region, seller_type, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
       on conflict(domain) do update set
         name        = coalesce(companies.name, excluded.name),
         country     = coalesce(companies.country, excluded.country),
         region      = coalesce(companies.region, excluded.region),
         seller_type = coalesce(companies.seller_type, excluded.seller_type),
         updated_at  = excluded.updated_at
       returning *`
    )
    .bind(newId(), domain, input.name ?? null, input.country ?? null,
          input.region ?? null, input.sellerType ?? null, now, now)
    .first<CompanyRow>();
}

export async function getCompanyByDomain(db: Db, domain: string): Promise<CompanyRow | null> {
  const key = normalizeDomain(domain);
  if (!key) return null;
  return db.prepare("select * from companies where domain = ?").bind(key).first<CompanyRow>();
}

export async function setCompanyStatus(
  db: Db, companyId: string, status: CompanyStatus, now: number
): Promise<void> {
  await db.prepare("update companies set status = ?, updated_at = ? where id = ?")
    .bind(status, now, companyId).run();
}

export async function suppressCompany(
  db: Db, companyId: string, reason: string, now: number
): Promise<void> {
  await db.prepare(
    "update companies set status = 'suppressed', suppressed_reason = ?, updated_at = ? where id = ?"
  ).bind(reason, now, companyId).run();
}

/** Append-only provenance. The same company found twice is two rows, by design. */
export async function recordSource(
  db: Db,
  input: { companyId: string; kind: SourceKind; detail?: string | null; supplyGapId?: string | null },
  now: number
): Promise<void> {
  await db.prepare(
    `insert into company_sources (id, company_id, source_kind, detail, supply_gap_id, discovered_at)
     values (?, ?, ?, ?, ?, ?)`
  ).bind(newId(), input.companyId, input.kind, input.detail ?? null,
         input.supplyGapId ?? null, now).run();
}

/** One crawl job per company; calling twice does not create a second. */
export async function openCrawlJob(db: Db, companyId: string, now: number): Promise<CrawlJobRow | null> {
  return db.prepare(
    `insert into crawl_jobs (id, company_id, status, attempts, next_eligible_at, created_at, updated_at)
     values (?, ?, 'queued', 0, 0, ?, ?)
     on conflict(company_id) do update set updated_at = excluded.updated_at
     returning *`
  ).bind(newId(), companyId, now, now).first<CrawlJobRow>();
}

/**
 * Jobs whose politeness window has opened. `next_eligible_at <= now` is the
 * gate — nothing is ever fetched before it.
 */
export async function dueCrawlJobs(db: Db, now: number, limit = 25): Promise<CrawlJobRow[]> {
  const { results } = await db.prepare(
    `select j.* from crawl_jobs j
     join companies c on c.id = j.company_id
     where j.status = 'queued' and j.next_eligible_at <= ?
       and c.status not in ('suppressed', 'converted', 'rejected')
     order by j.next_eligible_at asc
     limit ?`
  ).bind(now, limit).all<CrawlJobRow>();
  return results;
}

export async function updateCrawlJob(
  db: Db,
  input: {
    jobId: string;
    status: CrawlJobRow["status"];
    attempts?: number;
    nextEligibleAt?: number;
    lastError?: string | null;
    robotsAllowed?: boolean | null;
    robotsCheckedAt?: number | null;
    crawlDelayMs?: number | null;
  },
  now: number
): Promise<void> {
  await db.prepare(
    `update crawl_jobs set
       status            = ?,
       attempts          = coalesce(?, attempts),
       next_eligible_at  = coalesce(?, next_eligible_at),
       last_error        = ?,
       robots_allowed    = coalesce(?, robots_allowed),
       robots_checked_at = coalesce(?, robots_checked_at),
       crawl_delay_ms    = coalesce(?, crawl_delay_ms),
       updated_at        = ?
     where id = ?`
  ).bind(
    input.status,
    input.attempts ?? null,
    input.nextEligibleAt ?? null,
    input.lastError ?? null,
    input.robotsAllowed === null || input.robotsAllowed === undefined ? null : Number(input.robotsAllowed),
    input.robotsCheckedAt ?? null,
    input.crawlDelayMs ?? null,
    now,
    input.jobId
  ).run();
}

export async function recordPage(
  db: Db,
  input: {
    companyId: string; url: string; pageKind: PageKind;
    httpStatus?: number | null; contentHash?: string | null;
    r2Key?: string | null; bytes?: number | null; error?: string | null;
  },
  now: number
): Promise<string> {
  const id = newId();
  await db.prepare(
    `insert into crawl_pages (id, company_id, url, page_kind, http_status, content_hash, r2_key, bytes, fetched_at, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, input.companyId, input.url, input.pageKind, input.httpStatus ?? null,
         input.contentHash ?? null, input.r2Key ?? null, input.bytes ?? null,
         now, input.error ?? null).run();
  return id;
}

/** APPEND-ONLY. Never updates a previous run's facts. */
export async function appendFacts(
  db: Db,
  input: {
    companyId: string; runId: string; extractor: string; extractorVersion: string;
    facts: Record<string, unknown>; confidence?: number | null; sourcePageId?: string | null;
  },
  now: number
): Promise<string> {
  const id = newId();
  await db.prepare(
    `insert into company_facts (id, company_id, run_id, extractor, extractor_version, facts, confidence, source_page_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, input.companyId, input.runId, input.extractor, input.extractorVersion,
         JSON.stringify(input.facts), input.confidence ?? null,
         input.sourcePageId ?? null, now).run();
  return id;
}

export interface ProductInput {
  companyId: string; runId: string; title: string;
  sourceUrl?: string | null; rawCategory?: string | null;
  productType?: string | null; cannabinoid?: string | null; categorySlug?: string | null;
  priceCents?: number | null; currency?: string | null;
  weightGrams?: number | null; pricePerGram?: number | null;
  inStock?: boolean | null; wholesale?: boolean | null;
  extractor: string; confidence?: number | null;
}

/** APPEND-ONLY, written as one batch so a run lands whole or not at all. */
export async function appendProducts(db: Db, rows: ProductInput[], now: number): Promise<number> {
  if (rows.length === 0) return 0;
  const statements = rows.map((r) =>
    db.prepare(
      `insert into company_products
         (id, company_id, run_id, source_url, title, raw_category, product_type, cannabinoid,
          category_slug, price_cents, currency, weight_grams, price_per_gram, in_stock,
          wholesale, extractor, confidence, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      newId(), r.companyId, r.runId, r.sourceUrl ?? null, r.title, r.rawCategory ?? null,
      r.productType ?? null, r.cannabinoid ?? null, r.categorySlug ?? null,
      r.priceCents ?? null, r.currency ?? null, r.weightGrams ?? null, r.pricePerGram ?? null,
      r.inStock === null || r.inStock === undefined ? null : Number(r.inStock),
      r.wholesale === null || r.wholesale === undefined ? null : Number(r.wholesale),
      r.extractor, r.confidence ?? null, now
    )
  );
  await db.batch(statements);
  return rows.length;
}

/** APPEND-ONLY. Each scoring run is a new row carrying its weights version. */
export async function appendScore(
  db: Db,
  input: {
    companyId: string; score: number; components: Record<string, number>;
    weightsVersion: string; contactable: boolean;
    gateFailures?: string[]; supplyGapId?: string | null;
  },
  now: number
): Promise<string> {
  const id = newId();
  await db.prepare(
    `insert into prospect_scores
       (id, company_id, score, components, weights_version, contactable, gate_failures, supply_gap_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, input.companyId, input.score, JSON.stringify(input.components),
         input.weightsVersion, Number(input.contactable),
         JSON.stringify(input.gateFailures ?? []), input.supplyGapId ?? null, now).run();
  return id;
}

export interface ScoreRow {
  id: string; company_id: string; score: number; components: string;
  weights_version: string; contactable: number; gate_failures: string | null;
  supply_gap_id: string | null; created_at: number;
}

export async function currentScore(db: Db, companyId: string): Promise<ScoreRow | null> {
  return db.prepare("select * from current_scores where company_id = ?")
    .bind(companyId).first<ScoreRow>();
}

export interface ProspectListRow extends ScoreRow {
  domain: string;
  name: string | null;
  status: CompanyStatus;
}

/** Dashboard ranking: contactable prospects first, by score. */
export async function topProspects(
  db: Db, limit = 50, opts: { contactableOnly?: boolean } = {}
): Promise<ProspectListRow[]> {
  const filter = opts.contactableOnly ? "and s.contactable = 1" : "";
  const { results } = await db.prepare(
    `select s.*, c.domain, c.name, c.status
     from current_scores s
     join companies c on c.id = s.company_id
     where c.status not in ('suppressed', 'rejected') ${filter}
     order by s.score desc
     limit ?`
  ).bind(limit).all<ProspectListRow>();
  return results;
}

export async function currentProducts(db: Db, companyId: string) {
  const { results } = await db.prepare(
    "select * from current_products where company_id = ? order by title"
  ).bind(companyId).all();
  return results;
}

/** Funnel counters for the dashboard header. */
export async function statusCounts(db: Db): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("select status, count(*) as n from companies group by status")
    .all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, r.n]));
}
