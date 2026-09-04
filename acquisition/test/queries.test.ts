// Data-layer tests run the REAL migration against a real SQLite engine, so
// they exercise the schema itself — constraints, views, foreign keys — not a
// mock that would accept anything.

import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type FakeD1 } from "./helpers/d1";
import {
  appendFacts, appendProducts, appendScore, currentProducts, currentScore,
  dueCrawlJobs, getCompanyByDomain, normalizeDomain, openCrawlJob, recordPage,
  recordSource, setCompanyStatus, statusCounts, suppressCompany, topProspects,
  updateCrawlJob, upsertCompany, type Db,
} from "../src/db/queries";

let raw: FakeD1;
let db: Db;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  raw = createTestDb();
  db = raw as unknown as Db;
});

async function seedCompany(domain = "acme.com") {
  const c = await upsertCompany(db, { domain }, T0);
  if (!c) throw new Error("seed failed");
  return c;
}

describe("normalizeDomain", () => {
  it("reduces urls to the registrable host", () => {
    expect(normalizeDomain("https://www.Acme.com/shop?a=1")).toBe("acme.com");
    expect(normalizeDomain("http://acme.com")).toBe("acme.com");
    expect(normalizeDomain("acme.com/path")).toBe("acme.com");
    expect(normalizeDomain("ACME.COM")).toBe("acme.com");
  });

  it("strips ports, trailing dots and www", () => {
    expect(normalizeDomain("www.acme.com:8080")).toBe("acme.com");
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
  });

  it("keeps subdomains other than www", () => {
    expect(normalizeDomain("shop.acme.com")).toBe("shop.acme.com");
  });

  it("rejects junk", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("-bad.com")).toBeNull();
  });
});

describe("upsertCompany", () => {
  it("creates a company keyed on the normalized domain", async () => {
    const c = await upsertCompany(db, { domain: "https://www.Acme.com/shop", name: "Acme" }, T0);
    expect(c?.domain).toBe("acme.com");
    expect(c?.status).toBe("discovered");
  });

  it("is idempotent — the same company found twice stays one row", async () => {
    const a = await upsertCompany(db, { domain: "acme.com" }, T0);
    const b = await upsertCompany(db, { domain: "https://www.acme.com/", }, T0 + 1000);
    expect(b?.id).toBe(a?.id);
    const { results } = await db.prepare("select * from companies").all();
    expect(results).toHaveLength(1);
  });

  it("fills null fields on re-discovery but never overwrites known ones", async () => {
    await upsertCompany(db, { domain: "acme.com", name: "Acme Hemp" }, T0);
    const updated = await upsertCompany(
      db, { domain: "acme.com", name: "Wrong Name", region: "NC" }, T0 + 1
    );
    expect(updated?.name).toBe("Acme Hemp");   // preserved
    expect(updated?.region).toBe("NC");        // filled
  });

  it("returns null for an unusable domain instead of writing a row", async () => {
    expect(await upsertCompany(db, { domain: "not a domain" }, T0)).toBeNull();
    const { results } = await db.prepare("select * from companies").all();
    expect(results).toHaveLength(0);
  });
});

describe("getCompanyByDomain", () => {
  it("finds a company by any spelling of its domain", async () => {
    await seedCompany();
    expect((await getCompanyByDomain(db, "https://WWW.acme.com/x"))?.domain).toBe("acme.com");
  });

  it("returns null when absent", async () => {
    expect(await getCompanyByDomain(db, "nowhere.com")).toBeNull();
  });
});

describe("company status", () => {
  it("moves through the funnel and suppresses with a reason", async () => {
    const c = await seedCompany();
    await setCompanyStatus(db, c.id, "crawled", T0 + 1);
    expect((await getCompanyByDomain(db, "acme.com"))?.status).toBe("crawled");

    await suppressCompany(db, c.id, "opted_out", T0 + 2);
    const after = await getCompanyByDomain(db, "acme.com");
    expect(after?.status).toBe("suppressed");
    expect(after?.suppressed_reason).toBe("opted_out");
  });

  it("rejects a status outside the allowed set (schema constraint)", async () => {
    const c = await seedCompany();
    await expect(
      setCompanyStatus(db, c.id, "banana" as never, T0)
    ).rejects.toThrow();
  });
});

describe("recordSource", () => {
  it("appends provenance rows rather than replacing them", async () => {
    const c = await seedCompany();
    await recordSource(db, { companyId: c.id, kind: "seed", detail: "initial list" }, T0);
    await recordSource(db, { companyId: c.id, kind: "link_graph", detail: "https://x.com" }, T0 + 1);
    const { results } = await db.prepare("select * from company_sources").all();
    expect(results).toHaveLength(2);
  });

  it("enforces the source-kind constraint", async () => {
    const c = await seedCompany();
    await expect(
      recordSource(db, { companyId: c.id, kind: "telepathy" as never }, T0)
    ).rejects.toThrow();
  });
});

describe("crawl jobs", () => {
  it("opens one job per company, idempotently", async () => {
    const c = await seedCompany();
    const j1 = await openCrawlJob(db, c.id, T0);
    const j2 = await openCrawlJob(db, c.id, T0 + 5);
    expect(j2?.id).toBe(j1?.id);
  });

  it("returns only jobs whose politeness window has opened", async () => {
    const c = await seedCompany();
    const job = await openCrawlJob(db, c.id, T0);
    await updateCrawlJob(db, { jobId: job!.id, status: "queued", nextEligibleAt: T0 + 10_000 }, T0);

    expect(await dueCrawlJobs(db, T0 + 5_000)).toHaveLength(0);
    expect(await dueCrawlJobs(db, T0 + 10_000)).toHaveLength(1);
  });

  it("never returns jobs for suppressed companies", async () => {
    const c = await seedCompany();
    await openCrawlJob(db, c.id, T0);
    expect(await dueCrawlJobs(db, T0 + 1)).toHaveLength(1);

    await suppressCompany(db, c.id, "opted_out", T0 + 2);
    expect(await dueCrawlJobs(db, T0 + 3)).toHaveLength(0);
  });

  it("persists robots and backoff state", async () => {
    const c = await seedCompany();
    const job = await openCrawlJob(db, c.id, T0);
    await updateCrawlJob(db, {
      jobId: job!.id, status: "failed", attempts: 2,
      nextEligibleAt: T0 + 8000, lastError: "503",
      robotsAllowed: true, robotsCheckedAt: T0, crawlDelayMs: 5000,
    }, T0 + 1);

    const row = await db.prepare("select * from crawl_jobs where id = ?")
      .bind(job!.id).first<{ status: string; attempts: number; robots_allowed: number; crawl_delay_ms: number; last_error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(2);
    expect(row?.robots_allowed).toBe(1);
    expect(row?.crawl_delay_ms).toBe(5000);
    expect(row?.last_error).toBe("503");
  });

  it("orders due jobs by eligibility, oldest first", async () => {
    const a = await upsertCompany(db, { domain: "a.com" }, T0);
    const b = await upsertCompany(db, { domain: "b.com" }, T0);
    const ja = await openCrawlJob(db, a!.id, T0);
    const jb = await openCrawlJob(db, b!.id, T0);
    await updateCrawlJob(db, { jobId: ja!.id, status: "queued", nextEligibleAt: 200 }, T0);
    await updateCrawlJob(db, { jobId: jb!.id, status: "queued", nextEligibleAt: 100 }, T0);
    const due = await dueCrawlJobs(db, T0);
    expect(due[0]!.id).toBe(jb!.id);
  });
});

describe("crawl pages", () => {
  it("records a fetched page and returns its id", async () => {
    const c = await seedCompany();
    const id = await recordPage(db, {
      companyId: c.id, url: "https://acme.com/", pageKind: "home",
      httpStatus: 200, contentHash: "abc", r2Key: "raw/acme/home", bytes: 12345,
    }, T0);
    const row = await db.prepare("select * from crawl_pages where id = ?").bind(id)
      .first<{ page_kind: string; http_status: number }>();
    expect(row?.page_kind).toBe("home");
    expect(row?.http_status).toBe(200);
  });

  it("enforces the page-kind constraint", async () => {
    const c = await seedCompany();
    await expect(
      recordPage(db, { companyId: c.id, url: "u", pageKind: "spreadsheet" as never }, T0)
    ).rejects.toThrow();
  });
});

describe("append-only facts", () => {
  it("keeps every run rather than overwriting", async () => {
    const c = await seedCompany();
    await appendFacts(db, {
      companyId: c.id, runId: "run-1", extractor: "jsonld",
      extractorVersion: "1", facts: { productCount: 10 },
    }, T0);
    await appendFacts(db, {
      companyId: c.id, runId: "run-2", extractor: "jsonld",
      extractorVersion: "2", facts: { productCount: 25 },
    }, T0 + 1000);

    const { results } = await db.prepare("select * from company_facts order by created_at").all<{ facts: string }>();
    expect(results).toHaveLength(2);
    expect(JSON.parse(results[0]!.facts).productCount).toBe(10);
    expect(JSON.parse(results[1]!.facts).productCount).toBe(25);
  });

  it("round-trips structured facts through JSON", async () => {
    const c = await seedCompany();
    const facts = { wholesale: true, brands: ["a", "b"], region: null };
    await appendFacts(db, {
      companyId: c.id, runId: "r", extractor: "html", extractorVersion: "1", facts,
    }, T0);
    const row = await db.prepare("select facts from company_facts").first<{ facts: string }>();
    expect(JSON.parse(row!.facts)).toEqual(facts);
  });
});

describe("append-only products and current_products", () => {
  it("writes a run as a batch", async () => {
    const c = await seedCompany();
    const n = await appendProducts(db, [
      { companyId: c.id, runId: "r1", title: "THCA Flower", cannabinoid: "thca",
        categorySlug: "thca-flower", priceCents: 4499, extractor: "jsonld" },
      { companyId: c.id, runId: "r1", title: "CBG Flower", cannabinoid: "cbg",
        categorySlug: "cbg-flower", priceCents: 3999, extractor: "jsonld" },
    ], T0);
    expect(n).toBe(2);
    expect(await currentProducts(db, c.id)).toHaveLength(2);
  });

  it("returns an empty write as zero without touching the database", async () => {
    const c = await seedCompany();
    expect(await appendProducts(db, [], T0)).toBe(0);
    expect(await currentProducts(db, c.id)).toHaveLength(0);
  });

  it("current_products shows only the latest run, whole", async () => {
    const c = await seedCompany();
    await appendProducts(db, [
      { companyId: c.id, runId: "old", title: "Old A", extractor: "jsonld" },
      { companyId: c.id, runId: "old", title: "Old B", extractor: "jsonld" },
    ], T0);
    // A later run whose rows straddle a millisecond — the bug the view was
    // rewritten to avoid.
    await appendProducts(db, [{ companyId: c.id, runId: "new", title: "New A", extractor: "jsonld" }], T0 + 5000);
    await appendProducts(db, [{ companyId: c.id, runId: "new", title: "New B", extractor: "jsonld" }], T0 + 5001);

    const current = await currentProducts(db, c.id) as { title: string }[];
    expect(current.map((p) => p.title).sort()).toEqual(["New A", "New B"]);
  });
});

describe("append-only scores and current_scores", () => {
  it("stores components and the weights version", async () => {
    const c = await seedCompany();
    await appendScore(db, {
      companyId: c.id, score: 87.5, components: { marketFit: 1, productBreadth: 0.6 },
      weightsVersion: "v1", contactable: true,
    }, T0);
    const row = await currentScore(db, c.id);
    expect(row?.score).toBe(87.5);
    expect(row?.contactable).toBe(1);
    expect(JSON.parse(row!.components).marketFit).toBe(1);
    expect(row?.weights_version).toBe("v1");
  });

  it("current_scores returns exactly the newest run", async () => {
    const c = await seedCompany();
    await appendScore(db, { companyId: c.id, score: 40, components: {}, weightsVersion: "v1", contactable: false }, T0);
    await appendScore(db, { companyId: c.id, score: 90, components: {}, weightsVersion: "v2", contactable: true }, T0 + 1000);

    const row = await currentScore(db, c.id);
    expect(row?.score).toBe(90);
    expect(row?.weights_version).toBe("v2");

    const { results } = await db.prepare("select * from prospect_scores").all();
    expect(results).toHaveLength(2);   // history preserved
  });

  it("persists gate failures", async () => {
    const c = await seedCompany();
    await appendScore(db, {
      companyId: c.id, score: 95, components: {}, weightsVersion: "v1",
      contactable: false, gateFailures: ["no_role_contact", "robots_disallowed"],
    }, T0);
    const row = await currentScore(db, c.id);
    expect(JSON.parse(row!.gate_failures!)).toEqual(["no_role_contact", "robots_disallowed"]);
  });
});

describe("topProspects", () => {
  it("ranks by score and excludes suppressed companies", async () => {
    const a = await upsertCompany(db, { domain: "a.com" }, T0);
    const b = await upsertCompany(db, { domain: "b.com" }, T0);
    const c = await upsertCompany(db, { domain: "c.com" }, T0);
    await appendScore(db, { companyId: a!.id, score: 50, components: {}, weightsVersion: "v1", contactable: true }, T0);
    await appendScore(db, { companyId: b!.id, score: 90, components: {}, weightsVersion: "v1", contactable: true }, T0);
    await appendScore(db, { companyId: c!.id, score: 99, components: {}, weightsVersion: "v1", contactable: true }, T0);
    await suppressCompany(db, c!.id, "opted_out", T0 + 1);

    const top = await topProspects(db);
    expect(top.map((p) => p.domain)).toEqual(["b.com", "a.com"]);
  });

  it("can filter to contactable prospects only", async () => {
    const a = await upsertCompany(db, { domain: "a.com" }, T0);
    const b = await upsertCompany(db, { domain: "b.com" }, T0);
    await appendScore(db, { companyId: a!.id, score: 99, components: {}, weightsVersion: "v1", contactable: false }, T0);
    await appendScore(db, { companyId: b!.id, score: 10, components: {}, weightsVersion: "v1", contactable: true }, T0);

    const all = await topProspects(db);
    const gated = await topProspects(db, 50, { contactableOnly: true });
    expect(all).toHaveLength(2);
    expect(gated.map((p) => p.domain)).toEqual(["b.com"]);
  });

  it("respects the limit", async () => {
    for (const d of ["a.com", "b.com", "c.com"]) {
      const c = await upsertCompany(db, { domain: d }, T0);
      await appendScore(db, { companyId: c!.id, score: 50, components: {}, weightsVersion: "v1", contactable: true }, T0);
    }
    expect(await topProspects(db, 2)).toHaveLength(2);
  });
});

describe("statusCounts", () => {
  it("counts the funnel", async () => {
    const a = await upsertCompany(db, { domain: "a.com" }, T0);
    await upsertCompany(db, { domain: "b.com" }, T0);
    await setCompanyStatus(db, a!.id, "crawled", T0 + 1);
    expect(await statusCounts(db)).toEqual({ discovered: 1, crawled: 1 });
  });

  it("is empty for an empty database", async () => {
    expect(await statusCounts(db)).toEqual({});
  });
});

describe("schema integrity", () => {
  it("cascades child rows when a company is deleted", async () => {
    const c = await seedCompany();
    await recordSource(db, { companyId: c.id, kind: "seed" }, T0);
    await appendScore(db, { companyId: c.id, score: 1, components: {}, weightsVersion: "v1", contactable: false }, T0);

    await db.prepare("delete from companies where id = ?").bind(c.id).run();
    const { results } = await db.prepare("select * from prospect_scores").all();
    expect(results).toHaveLength(0);
  });

  it("refuses a score for a company that does not exist", async () => {
    await expect(
      appendScore(db, { companyId: "ghost", score: 1, components: {}, weightsVersion: "v1", contactable: false }, T0)
    ).rejects.toThrow();
  });
});
