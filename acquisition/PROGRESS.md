# Acquisition Engine — Build Progress

**This file is the build's memory.** Each autonomous session reads it, does the
next unchecked task, updates it, and commits. Keep it accurate and terse.

Working dir: `acquisition/` in `KingsleyLeshey/bhfnm-marketplace`
Branch: `claude/project-status-report-5m5ke1`
Last updated: 2026-09-04

---

## Ground rules — do not violate these

1. **Never modify anything outside `acquisition/`.** The marketplace app
   (`src/`, `supabase/`, `wordpress/`) is off limits. No imports from it either
   — copy what you need. The user's constraint is explicit and load-bearing.
2. **Never write to the marketplace database.** The gap engine reads aggregates
   over a read-only credential; that is all.
3. **Prospect data never reaches a public marketplace surface.**
4. **No AI-inferred compliance facts.** Potency, COA status, legality and batch
   data come from verified documents, never from marketing copy or a model.
5. **Deterministic extraction first; AI only fills what it could not find.**
6. **Every new module gets tests.** Pure logic must be unit tested — the
   marketplace shipped with none, and that is the mistake not to repeat.
7. **`npx vitest run` and `npx tsc --noEmit` must both pass before committing.**
8. Hard gates stay separate from the weighted score, always.

## Environment constraint — READ THIS BEFORE PLANNING CRAWL WORK

**This build environment cannot reach the public web.** Outbound HTTPS goes
through a policy-enforcing egress proxy that denies general hosts:

```
$ curl -i https://example.com/
curl: (56) CONNECT tunnel failed, response 403
```

Verified 2026-09-04 against `example.com` and three hemp sites — all 403 at the
CONNECT stage, which is an organisation egress-policy denial, not the sites
blocking us. `$HTTPS_PROXY/__agentproxy/status` shows the proxy healthy with no
relay failures, so this is policy, not fault. **Do not retry, do not try to
route around it, do not add proxy workarounds.**

What this means for the build:

- Crawl and extraction code can be written and unit tested here, but **cannot
  be validated against live sites from this environment**.
- **The accuracy harness (T11) must run against saved HTML fixtures committed
  under `test/fixtures/`, not live fetches.** Design it that way from the
  start; a live-fetch harness cannot run here at all.
- Real-world validation happens either from committed fixtures, or after
  deployment, where the Worker fetches from Cloudflare's network rather than
  through this proxy.
- Fixtures are therefore a **user blocker** (below): saved HTML pages are
  needed before extraction accuracy can be measured.

## Blocked on the user — do not attempt these

These need credentials or accounts only Kingsley can create. **Do not fake
them, do not stub around them silently, do not deploy.** Build the code so it
is ready, and note the blocker here.

- [ ] Cloudflare paid Workers plan (Queues, Browser Rendering, Workers AI)
- [ ] `wrangler d1 create bhfnm-acquisition` → real `database_id` in wrangler.toml
- [ ] R2 bucket `bhfnm-acquisition-raw`
- [ ] Search API key (Serper / Brave / Google CSE) — or confirm link-graph-only
- [ ] Outreach domain, separate from buyhempflowernearme.com (buy early: 3–4
      week warmup is the long pole)
- [ ] Read-only Supabase credentials for marketplace aggregates
- [ ] US business entity + postal address (CAN-SPAM footer, seller trust)
- [ ] **Saved HTML fixtures for the accuracy harness** — 15–20 real hemp
      supplier pages saved from a browser (Ctrl+S, "web page, HTML only") and
      dropped into `acquisition/test/fixtures/`, ideally a mix of Shopify,
      WooCommerce and custom sites. Needed to measure extraction accuracy,
      which is the Phase 2 gate. This environment cannot fetch them itself.

---

## Phase 1 — Acquisition intelligence

### Done

- [x] Project scaffold: wrangler.toml, tsconfig, vitest, package.json
- [x] D1 schema `migrations/0001_init.sql` — 7 tables, facts/scores append-only,
      `current_scores` / `current_products` views for latest-run reads
- [x] `src/crawl/robots.ts` — robots.txt parser, group selection, `*`/`$` path
      matching, longest-match precedence *(12 tests)*
- [x] `src/crawl/politeness.ts` — effective delay, exponential backoff,
      Retry-After precedence, retry policy, never-crawl host list *(16 tests)*
- [x] `src/extract/jsonld.ts` — deterministic Product/Organization harvest,
      @graph walking, AggregateOffer unwrapping *(10 tests)*
- [x] `src/extract/normalize.ts` — cannabinoid + form detection, weight parsing,
      category mapping, price per gram *(19 tests)*
- [x] `src/score/prospect.ts` — weighted scoring, versioned weights, hard gates
      held separate, SEO opportunity proxy *(17 tests)*
- [x] `src/index.ts` — Worker entry with fetch/queue/scheduled surfaces
- [x] `src/extract/html.ts` — meta/OG facts, email and phone harvesting, social
      links, capability signals, internal-link depth, blog detection *(29 tests)*
- [x] `src/extract/contacts.ts` — role-address allowlist, never-contact list,
      junk-domain filter, provenance, own-domain preference *(21 tests)*
- [x] `src/db/queries.ts` — D1 data layer: domain-keyed idempotent company
      upsert, provenance, crawl-job lifecycle with the politeness gate,
      append-only facts/products/scores, current-value reads, funnel counts
      *(36 tests)*
- [x] `test/helpers/d1.ts` — fake D1 over `node:sqlite`, so tests run the REAL
      migration against a real SQLite engine and exercise the schema itself
- [x] Fixed a latent view bug: `current_products` / `current_scores` keyed on
      `max(created_at)` silently dropped part of a run whose inserts straddled
      a millisecond. Now keyed on the latest run id. Regression test included.
- [x] **160 tests passing, typecheck clean**

### Next — in order

- [ ] **T4. Crawl consumer** (`src/crawl/fetcher.ts` + wire `queue()`)
      robots fetch and cache → politeness gate → fetch home/sitemap/about/contact
      → store raw in R2 → write `crawl_pages`. Honour `next_eligible_at`
      absolutely. Identify with `CRAWLER_USER_AGENT`.
- [ ] **T5. Extraction pipeline** (`src/extract/run.ts`)
      Deterministic pass over stored pages → `company_facts` + `company_products`
      under one `run_id`. Confidence = coverage of required fields.
- [ ] **T6. Supply gap engine** (`src/gaps/`)
      Marketplace aggregates (category product counts, active vendors,
      geographic coverage) → ranked gaps. Until read-only Supabase creds exist,
      read from a committed fixture and mark it clearly as a fixture.
- [ ] **T7. Query generation** (`src/discover/queries.ts`)
      Gap → search queries. Pure and tested; no network.
- [ ] **T8. Discovery adapters** (`src/discover/`)
      Search API adapter behind an interface, plus link-graph expansion
      (extract outbound brand/supplier links from crawled pages → new companies).
      Link-graph works with no vendor and compounds — build it first.
- [ ] **T9. Scoring runner** — assemble ScoreInputs from facts, persist a run.
- [ ] **T10. Dashboard** (`src/dashboard/`) — server-rendered HTML behind
      Cloudflare Access. Ranked prospects, detail view, facts with provenance,
      gap list, funnel counters.
- [ ] **T11. Accuracy harness** (`test/fixtures/`, `src/eval/`)
      Runs over **saved HTML fixtures** (see the environment constraint above —
      live fetching is impossible here). Hand-label expected fields per fixture,
      report precision/recall per field. **This is the Phase 2 gate.** Record
      the number in this file. Blocked until fixtures exist.

## Phase 2 — Outreach (do not start until T11 reports acceptable accuracy)

Draft generation from real extracted facts; self-governing send gate (role
addresses only, confidence and score thresholds, volume ramp by domain age,
auto-pause on complaint/bounce/sentiment thresholds); suppression list checked
before every send; reply ingestion and classification; CAN-SPAM footer.
`AUTOPILOT` stays `"false"` until reply data justifies flipping it.

## Phase 3 — Onboarding handoff

Application prefill from extracted data. **Vendor approval stays human** — the
marketplace's entire positioning is verified-and-compliance-first, and an
auto-approved seller is the one failure that damages the marketplace itself.

## Phase 4 — SEO opportunities

Gap + catalog data → content proposals. Drafts, never mass auto-publication.

---

## Session log

| Date | Session | Work |
|---|---|---|
| 2026-09-03 | initial | Scaffold, schema, robots, politeness, JSON-LD, normalization, scoring. 74 tests. |
| 2026-09-04 | interactive | T1 html.ts + T2 contacts.ts (50 new tests, 124 total). Discovered and documented the egress-policy constraint; retargeted T11 at saved fixtures and added fixtures as a user blocker. |
| 2026-09-04 | interactive | T3 db/queries.ts + SQLite-backed D1 test harness (36 tests, 160 total). Fixed the current_* view bug. Schedule moved to hourly. |
