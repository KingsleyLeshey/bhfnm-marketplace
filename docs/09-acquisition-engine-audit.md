# Phase 0 — Architecture Audit: Acquisition Engine

Audit date: 2026-09-03 · Codebase at `313a3cd` · **No production code modified.**

Scope note: this audit reads the repository. It cannot see the live database, so
statements about *code and schema* are verified, while statements about *how much
supply is actually in production* are not — I flag those inline. Nothing here
assumes the target architecture already exists.

---

## A. What exists today

### Runtime shape

| Layer | Reality |
|---|---|
| App | Next.js 15 App Router, React 19, TypeScript strict, `basePath=/marketplace` |
| Hosting | Vercel |
| Data | Supabase Postgres — **47 tables**, RLS-enforced |
| Auth | Supabase Auth, cookie sessions, 3 roles (`buyer`/`vendor`/`admin`) |
| Search | Postgres FTS — weighted tsvector + trigram, `search_products` RPC |
| Storage | Supabase Storage (`product-images` live; other buckets specified, unused) |
| Payments | BTCPay adapter + HMAC webhook (written, never exercised against a real invoice) |
| Email | Resend adapter, no-ops without keys |
| Cloudflare | **One Worker. A reverse proxy. Zero bindings.** |
| Async execution | **None. No cron, no queue, no worker, no scheduled task.** |
| Tests | **None.** No runner, no test files. |

### The schema is much bigger than the app

The 47 tables already model fulfillment, payouts, reserves, fraud, risk scores,
disputes, referral attribution and sponsored placement — most of it unused by
any code path. The database was designed for the full roadmap; the application
implements roughly the first half.

This matters for your proposal in a specific way: **the schema is not the
constraint. Execution substrate is.**

### Verified today

`pnpm typecheck` and `pnpm build` both pass on a clean install. 105 TS/TSX files,
~11k LOC, 5 migrations, 18 API routes.

---

## B. What to preserve — and what is more reusable than you'd expect

Four existing pieces are direct building blocks for the acquisition engine. This
is the strongest argument against starting a greenfield second system.

### 1. `seller_type` already *is* your prospect taxonomy

```sql
create type seller_type as enum (
  'hemp_farm','manufacturer','cbd_brand','cbg_brand','thca_brand',
  'hd_cannabinoid_brand','beverage_brand','wellness_brand','accessory_retailer',
  'distributor','wholesaler','retail_store','private_label','dropshipper','reseller');
```

Compare that to the business types listed in your §7. It is nearly a one-to-one
match, and it was written for *onboarded vendors*. Use it as the classification
target for discovered companies too: one vocabulary from prospect through
onboarding means a converted prospect keeps its type, and acquisition ROI can
later be measured per seller type without a mapping layer.

### 2. `cannabinoid_type` already *is* your normalization target

```sql
create type cannabinoid_type as enum
  ('cbd','cbg','cbn','thca','delta9_hemp','delta8','hhc','mixed','none');
```

Your §8 example — "THCA Flower" / "THCa Hemp Flower" / "High THCA Flower" all
normalizing to `cannabinoid = THCA` — resolves to this enum plus the existing
15-category taxonomy (which already includes `thca-flower`, `cbd-flower`,
`cbg-flower`, `wholesale`, `farm-direct`, `manufacturer-direct`). The
normalization target exists. Only the extraction side is missing.

### 3. `lib/health-score.ts` is the scoring engine you're asking for

It already implements exactly the pattern §9 describes: named components
normalized to 0..1, a separate weights table, clamping, Bayesian smoothing so
small samples don't dominate, and — importantly — **hard trust gates kept
separate from the weighted score** (`sponsoredEligible()`), so eligibility is
never traded away by a high score elsewhere.

It is a pure function with no database or Node dependency. It runs unmodified in
a Cloudflare Worker. Port the pattern; don't reinvent it. The `sponsoredEligible`
split is the part to copy most deliberately: prospect scoring needs the same
distinction between "high score" and "legally contactable."

### 4. `lib/import.ts` is two-thirds of the crawler's extraction layer

The Shopify/WooCommerce importer is dependency-free string processing — its own
CSV parser, HTML stripper, price and variant normalizer. No Node APIs. It runs
in a Worker as-is, and its `ImportedRow` output shape is very close to what
crawl-time product extraction needs to emit.

Its real limits, for planning: it takes only the first variant per product, does
no duplicate detection, and does no COA matching.

### Also preserve

- **Auth and the admin shell.** `requireRole()`, `DashboardShell`, the admin nav
  and the existing review-queue UI pattern. The acquisition dashboard should be
  an admin route in the existing app — not a second auth system.
- **The truthfulness guard** (`dataMode()`), which is the marketplace's core
  positioning. See the boundary rule in §E.
- **The category tree and `search_facts`.** Categories are the denominator for
  every supply-gap calculation; `search_facts` is an existing precedent for
  "structured fact block attached to a record."

---

## C. What is missing

### The blocking gap: there is no async execution anywhere

Every "queue" in the current codebase is a *human review queue* rendered from
table rows. There is no cron, no job runner, no message queue, no background
worker. Every line of code runs inside a request.

The acquisition engine is, structurally, the opposite: long-running, scheduled,
retrying, rate-limited, partially-failing work. **This gap — not AI, not
crawling — is what Phase 1 has to establish.** Everything else is downstream.

### Missing for Phase 1, minimum viable

1. An async substrate (queue + scheduled trigger + durable job state).
2. Outbound HTTP fetching with a politeness layer (robots.txt, per-host rate
   limiting, backoff, user-agent identification).
3. Raw-artifact storage — fetched HTML kept for re-extraction without re-crawling.
4. A structured extraction pipeline, deterministic first (see §F.5).
5. A company/prospect namespace **separate from `vendors`** (see §D).
6. Provenance and history tables, so every fact traces to a fetch.
7. An extraction accuracy harness. You have no tests today; an intelligence layer
   whose accuracy nobody measures produces confident nonsense scores.

### Explicitly *not* needed for Phase 1

Discovery vendors, Vectorize, Durable Objects, agents, outreach, email
infrastructure, supply gaps. See §F and §H.

---

## D. Schema — and the one mistake to avoid

### Do not put prospects in `vendors`

`vendors.owner_id` is `not null references profiles(id)` — a vendor row requires
a real authenticated user. A prospect is a company that has never heard of you.
There is no user to point at.

You could relax the constraint. Don't. Three reasons:

1. **RLS on `vendors` is written around owner-or-admin access.** Unowned rows sit
   in a policy model that has no rule for them.
2. **The public catalog reads `vendors`.** Speculative, unverified, AI-extracted
   company data would live one predicate away from public marketplace surfaces —
   directly against the truthfulness guarantee the marketplace is positioned on.
3. **They are different data with different lifecycles.** Vendor data is
   authoritative and vendor-supplied; prospect data is inferred, decaying, and
   frequently wrong. Mixing them makes both untrustworthy.

Keep them separate namespaces. Conversion is a link, not a merge.

### Phase 1 schema — 7 tables, not 25

Your §6 lists ~25 entities. Most encode phases you haven't reached. Build these:

| Table | Purpose | Shape |
|---|---|---|
| `companies` | Prospect identity. `domain` unique; name, location, `seller_type` guess, status | Mutable state |
| `company_sources` | How and when each company was discovered; provenance | **Append-only** |
| `crawl_jobs` | Per-company fetch state: status, attempts, `robots_allowed`, last error, next-eligible-at | Mutable state |
| `crawl_pages` | One row per fetched URL → R2 key, HTTP status, content hash, fetched-at | **Append-only** |
| `company_facts` | Extracted intelligence, **one row per extraction run**, with model/version, confidence, and source page ref | **Append-only** |
| `company_products` | Extracted products, normalized to `cannabinoid_type` + category | Append-only per run |
| `prospect_scores` | One row per scoring run: score, components JSONB, weights version | **Append-only** |

The append-only split is deliberate and answers your §6 question directly. Facts
and scores must be history, not mutable state, because you will change extractors
and weights repeatedly — and when a score moves you need to know whether the
company changed or your model did. Current values come from a view selecting the
latest run per company.

### The contract with the marketplace

One direction only. The acquisition system reads a periodic export of marketplace
aggregates (products and active vendors per category, geography coverage) for gap
math. It never writes to marketplace tables. `companies.converted_vendor_id`
stores the vendor UUID as a plain column with **no cross-system foreign key**.

### Defer

`supply_gaps` (Phase 2 — needs demand data you don't have wired yet),
everything outreach- and email-related (Phase 2), `seller_*` tables (mostly exist
already as `vendor_applications` / `vendor_documents` / `compliance_records`),
`seo_*` (Phase 4). In Phase 1, category priority can be a small static seed table
— it's a weighting input, not a subsystem.

---

## E. Cloudflare architecture

### Recommendation: do not migrate the marketplace

Run the acquisition engine as a **separate Cloudflare Workers service with its
own D1**, and leave the marketplace on Vercel + Supabase.

The reason is specific, not ideological. **Postgres RLS is the marketplace's
security backbone** — the third layer under middleware and server-side role
guards, and the one that holds when application code is wrong. D1 has no
row-level security. Migrating means reimplementing every access rule in
application code, hand-auditing all 47 tables, and losing defence in depth — for
a system whose distinguishing claim is compliance rigor. Migration is a rewrite
of the security model with zero user-visible benefit.

The acquisition engine, by contrast, is a *natural* Cloudflare workload: no user
sessions, no RLS need, internal-only readers, crawl-heavy, bursty, and much
cheaper on egress-free storage. Two systems, one narrow read-only contract.

| Service | Use it for | Verdict |
|---|---|---|
| **Workers** | Acquisition API + job consumers | **Yes — core** |
| **Queues** | Crawl and extraction dispatch, retries, rate limiting | **Yes — this is the missing substrate** |
| **R2** | Raw fetched HTML, later import files | **Yes** — re-extract without re-crawling; no egress cost |
| **D1** | Acquisition tables only | **Yes, scoped.** Not the marketplace |
| **Workers AI** | Extraction of fields deterministic parsing misses; classification | **Yes, second pass only** (§F.6) |
| **Browser Rendering** | JS-only sites that return no useful HTML | **Sparingly** — slow, costly, concurrency-limited. Plain fetch first; escalate only on failure |
| **Cron Triggers** | Scheduled crawl waves, score recomputation | **Yes** |
| **Workflows** | Multi-step acquisition sequences with durable state | **Phase 2** — Queues cover Phase 1; adopt when steps span days |
| **Vectorize** | Similarity, dedupe, "companies like our best sellers" | **Phase 2+.** Needs converted sellers to embed against; premature now |
| **Durable Objects** | Per-host crawl rate-limit coordination; later, conversation state | **Only if Queue concurrency proves insufficient** |
| **Agents** | Agentic acquisition flows | **Not yet.** Deterministic pipeline first |
| **Email Service** | Cold outreach | **No — see §G.** Use a dedicated outbound provider on a separate domain |
| **DNS/CDN/WAF** | Already in place | Keep |

### The boundary rule

Acquisition data is **internal-only** and must never render on a public
marketplace surface. Not on a store page, not in search, not in a sitemap, not in
JSON-LD. The marketplace's `dataMode()` guarantee is that the public catalog
shows only verified, vendor-supplied records; AI-inferred company data appearing
publicly would break that guarantee and the positioning built on it. Enforce this
by keeping the data in a different database the marketplace app has no read path
to — architecture, not discipline.

---

## F. Phase 1 implementation plan

### One scope change I'd argue for

Your §18 puts *discovery* first. I'd defer it and **seed the first companies from
a hand-built list.**

Discovery is the step with a paid vendor dependency, the largest legal surface,
and the least learning per unit of work. The actual risk in Phase 1 is whether
**extraction and scoring produce something a human agrees with** — and you can
test that on 100 seeded domains you already know. If extraction is unreliable,
discovering 10,000 more companies just scales the unreliability.

Prove the loop, then buy volume:

```
SEED (manual) → CRAWL → EXTRACT → NORMALIZE → SCORE → REVIEW
```

Add automated discovery at the head once extraction accuracy is measured.

### Tasks — each independently testable

| # | Task | Done when |
|---|---|---|
| 1 | Worker + D1 + Queue scaffold, wrangler config, migration runner, health endpoint | `/health` reports D1 and Queue bindings |
| 2 | Phase 1 schema (7 tables) + latest-run views | Migrations apply and roll back cleanly |
| 3 | Seed ingest: CSV of domains → `companies` + `company_sources` | 100 seeded domains, deduped by registrable domain |
| 4 | Politeness layer: robots.txt parse, per-host rate limit, backoff, identifying UA | **Pure functions, unit tested.** Disallowed path is never fetched |
| 5 | Fetch pipeline: Queue consumer → homepage + sitemap + about/contact → R2 → `crawl_pages` | Raw HTML in R2, retries survive failure, no host over-fetched |
| 6 | **Deterministic extraction**: JSON-LD `Product`/`Organization`, OpenGraph, meta, contact blocks | Structured facts with zero AI calls |
| 7 | **AI extraction, second pass only**: Workers AI fills fields step 6 missed; every field carries confidence + source page | Never overwrites a deterministic value |
| 8 | Product normalization: extracted titles → `cannabinoid_type` + category, reusing `import.ts` patterns | "THCa Hemp Flower" → `thca` / `thca-flower` |
| 9 | Scoring: port the `health-score.ts` pattern; weights versioned in config; hard gates separate | Score + components persisted per run, reproducible |
| 10 | **Accuracy harness**: 20 hand-labeled companies, precision/recall per field | Reported as a number. **Gate for Phase 2** |
| 11 | Dashboard: admin route in the existing Next.js app behind `requireRole("admin")`, reading the acquisition API | Prospect list, sortable by score; detail view with facts, products, provenance |

### Why deterministic extraction before AI (task 6 before 7)

Hemp e-commerce runs overwhelmingly on Shopify and WooCommerce, and both emit
JSON-LD `Product` markup by default. For a large share of targets, product
catalogs, prices and variants are available as *structured data you can parse
exactly* — no model, no hallucination, no per-page cost, and trivially testable.
This is the same insight your existing CSV importer already exploits.

Use AI for what's genuinely unstructured: business type, wholesale availability,
brand positioning, contact-page interpretation. That inverts the usual cost and
reliability curve, and it means an AI outage degrades the pipeline instead of
stopping it.

### Phase 2 gate

Do not build outreach until task 10 reports acceptable accuracy on a labeled set,
**and** a human reviewer agrees with the top-20 ranking. Scoring on bad extraction
is worse than no scoring — it launders errors into confident numbers, and the
first thing you'd do with those numbers is email strangers.

---

## G. Risks

### Crawling

Respect robots.txt, rate-limit per host, identify the crawler honestly with a
contact URL, and cache aggressively so you fetch each page once. Never attempt
to bypass authentication, CAPTCHAs, paywalls or other access controls — this is a
hard line, and it also keeps you clear of the worst of the legal exposure.
Scraping public pages is broadly defensible; circumventing controls is not.
Browser Rendering raises cost and concurrency pressure, so gate it behind a
deterministic-fetch failure.

### Privacy and contact data

Collect **role-based business contacts** (`info@`, `sales@`, `wholesale@`), not
named individuals' personal addresses — the compliance profile is materially
different under GDPR/CCPA, and role addresses are what you actually want anyway.
Record lawful basis and source URL per contact, and honor deletion requests. If
you ever target EU or UK companies, B2B cold email rules differ per member state;
scope to US first.

### Email — the one that can damage the existing business

**Never send cold outreach from `buyhempflowernearme.com`.** A cold program's
complaint and bounce rates will damage the sending reputation of whatever domain
carries it. That domain currently carries your transactional mail — password
resets, application decisions, payment receipts. Burning it means sellers stop
receiving the mail the marketplace depends on.

Use a separate domain with its own SPF/DKIM/DMARC, a dedicated outbound provider,
gradual warmup, hard volume caps, suppression lists honored before every send,
bounce and complaint handling, and one-click opt-out. Human approval on every
message until the reply data justifies otherwise. This is also why Cloudflare
Email Service is the wrong tool here — cold outreach needs deliverability
tooling, reputation monitoring and complaint feedback loops that a general
sending API doesn't provide.

### AI reliability

Extraction hallucinates: invented product counts, misread prices, confident
wrong classifications. Mitigations: deterministic-first, confidence scores,
provenance on every field, and never let a model assert a **regulated or
compliance fact**. The existing codebase already holds this line — COA data is
structured and human-verified, and badges derive from verified records. Do not
let the acquisition engine become the exception that erodes it.

### Scale and cost

D1 has per-database size and write-throughput limits — fine for a prospect
database, not for raw pages, which is why HTML belongs in R2. Workers have CPU
time limits per invocation: chunk extraction, never process a whole site in one
call. Budget Workers AI per page and set a ceiling before running a large wave.

### Dependencies

Discovery data vendors (deferred, deliberately), outbound email provider, and
eventually KYB. Each is replaceable if you keep extraction output in your own
normalized shape rather than storing vendor payloads directly.

### Compliance

Hemp is jurisdictionally messy, which the marketplace already models
(`jurisdiction_rules`, `restricted_jurisdictions`). Prospecting adds a new
wrinkle: a company can be legal in its state and illegal to onboard for shipping
into others. Keep acquisition scoring separate from compliance eligibility —
score says "worth pursuing," a separate gate says "can be onboarded." Same
split as `sponsoredEligible()`.

---

## H. Summary — the smallest clean evolution

1. **Don't migrate the marketplace.** RLS is load-bearing; D1 has no equivalent.
2. **Build the acquisition engine as a separate Cloudflare service** with its own
   D1, reading a one-way export from the marketplace.
3. **The gap is async execution, not AI.** Queues, cron and durable job state are
   the Phase 1 deliverable.
4. **Reuse four existing assets:** `seller_type` as the prospect taxonomy,
   `cannabinoid_type` + categories as the normalization target,
   `health-score.ts` as the scoring pattern, `import.ts` as the extraction base.
5. **Prospects never live in `vendors`.**
6. **Seed manually; defer discovery.** Prove extraction before buying volume.
7. **Deterministic extraction first, AI second.**
8. **Gate Phase 2 on a measured accuracy number,** not on the pipeline running.
9. **Cold outreach never touches the primary domain.**

Seven tables, one Worker, one queue, one bucket, and a hand-seeded list. That is
the whole of Phase 1.
