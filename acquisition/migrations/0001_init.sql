-- 0001_init.sql — acquisition engine core.
--
-- Design rules enforced here:
--   1. Prospect data NEVER lives in the marketplace database. This is a
--      separate D1 instance; the marketplace app has no read path to it.
--   2. Facts and scores are APPEND-ONLY. Extractors and weights will change
--      repeatedly; when a score moves we must be able to tell whether the
--      company changed or our model did. Current values come from views.
--   3. Every extracted fact traces back to the fetch it came from.

-- ============================================================ companies
-- Prospect identity. `domain` is the registrable domain, lowercased, and is
-- the dedupe key — a company is its domain.
create table companies (
  id            text primary key,           -- uuid
  domain        text not null unique,
  name          text,
  country       text,                        -- ISO-3166 alpha-2
  region        text,                        -- state / province
  seller_type   text,                        -- mirrors marketplace seller_type enum
  status        text not null default 'discovered'
                check (status in ('discovered','crawling','crawled','scored',
                                  'contactable','contacted','replied',
                                  'converted','rejected','suppressed')),
  -- Set when this prospect becomes a marketplace vendor. Deliberately NOT a
  -- foreign key: it points into a different database, in a different system.
  converted_vendor_id text,
  suppressed_reason   text,
  created_at    integer not null,            -- epoch ms
  updated_at    integer not null
);
create index companies_status_idx on companies (status);
create index companies_seller_type_idx on companies (seller_type);

-- ============================================================ provenance
-- How each company entered the pipeline. Append-only: a company can be
-- discovered repeatedly by different means, and that is itself signal.
create table company_sources (
  id           text primary key,
  company_id   text not null references companies(id) on delete cascade,
  source_kind  text not null
               check (source_kind in ('seed','search_query','link_graph',
                                      'directory','manual','referral')),
  detail       text,                          -- the query, or the linking URL
  supply_gap_id text,                         -- which gap motivated this search
  discovered_at integer not null
);
create index company_sources_company_idx on company_sources (company_id);

-- ============================================================ crawl state
-- Mutable per-company fetch state. `next_eligible_at` is the politeness gate:
-- nothing is fetched before it, ever.
create table crawl_jobs (
  id               text primary key,
  company_id       text not null references companies(id) on delete cascade,
  status           text not null default 'queued'
                   check (status in ('queued','running','done','failed','blocked')),
  attempts         integer not null default 0,
  robots_allowed   integer,                   -- 0/1/null=unknown
  robots_checked_at integer,
  crawl_delay_ms   integer,                    -- from robots.txt, if declared
  next_eligible_at integer not null default 0,
  last_error       text,
  created_at       integer not null,
  updated_at       integer not null
);
create index crawl_jobs_status_idx on crawl_jobs (status, next_eligible_at);
create unique index crawl_jobs_company_idx on crawl_jobs (company_id);

-- One row per fetched URL. Body goes to R2; only the pointer lives here.
create table crawl_pages (
  id           text primary key,
  company_id   text not null references companies(id) on delete cascade,
  url          text not null,
  page_kind    text not null                  -- home|sitemap|product|about|contact|other
               check (page_kind in ('home','sitemap','product','about','contact','other')),
  http_status  integer,
  content_hash text,                          -- skip re-extraction when unchanged
  r2_key       text,
  bytes        integer,
  fetched_at   integer not null,
  error        text
);
create index crawl_pages_company_idx on crawl_pages (company_id, fetched_at);

-- ============================================================ intelligence
-- APPEND-ONLY. One row per extraction run per company.
create table company_facts (
  id             text primary key,
  company_id     text not null references companies(id) on delete cascade,
  run_id         text not null,               -- groups facts from one extraction pass
  extractor      text not null,               -- 'jsonld' | 'html' | 'ai:<model>'
  extractor_version text not null,
  -- Structured intelligence as JSON. Shape is versioned by extractor_version
  -- rather than by columns, because this is exactly the part that will churn.
  facts          text not null,               -- JSON object
  confidence     real,                        -- 0..1, null for deterministic extractors
  source_page_id text references crawl_pages(id),
  created_at     integer not null
);
create index company_facts_company_idx on company_facts (company_id, created_at desc);
create index company_facts_run_idx on company_facts (run_id);

-- Products found on a company's own site, normalized toward the marketplace
-- taxonomy. Append-only per run for the same reason as facts.
create table company_products (
  id              text primary key,
  company_id      text not null references companies(id) on delete cascade,
  run_id          text not null,
  source_url      text,
  title           text not null,
  raw_category    text,                       -- what THEY called it
  product_type    text,                       -- our normalized type
  cannabinoid     text,                       -- marketplace cannabinoid_type
  category_slug   text,                       -- marketplace category
  price_cents     integer,
  currency        text,
  weight_grams    real,
  price_per_gram  real,
  in_stock        integer,                    -- 0/1/null
  wholesale       integer,                    -- 0/1/null
  extractor       text not null,
  confidence      real,
  created_at      integer not null
);
create index company_products_company_idx on company_products (company_id, run_id);
create index company_products_cannabinoid_idx on company_products (cannabinoid);

-- ============================================================ scoring
-- APPEND-ONLY. One row per scoring run. `components` and `weights_version`
-- make every historical score reproducible and explainable.
create table prospect_scores (
  id              text primary key,
  company_id      text not null references companies(id) on delete cascade,
  score           real not null,              -- 0..100
  components      text not null,              -- JSON: {dimension: 0..1}
  weights_version text not null,
  -- Hard gates, kept separate from the weighted score so a high score can
  -- never buy its way past them. Mirrors the marketplace's trust-gate pattern.
  contactable     integer not null default 0,
  gate_failures   text,                       -- JSON array of failed gate names
  supply_gap_id   text,
  created_at      integer not null
);
create index prospect_scores_company_idx on prospect_scores (company_id, created_at desc);
create index prospect_scores_rank_idx on prospect_scores (score desc);

-- ============================================================ current-value views
-- Latest run per company. Everything downstream reads these, never the raw
-- append-only tables, so history never has to be mutated.
create view current_scores as
select s.*
from prospect_scores s
join (
  select company_id, max(created_at) as max_created
  from prospect_scores group by company_id
) latest
  on latest.company_id = s.company_id and latest.max_created = s.created_at;

create view current_products as
select p.*
from company_products p
join (
  select company_id, max(created_at) as max_created
  from company_products group by company_id
) latest
  on latest.company_id = p.company_id and latest.max_created = p.created_at;
