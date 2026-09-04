// Cloudflare bindings for the acquisition Worker.
//
// Note what is NOT here: any binding to the marketplace's Supabase database.
// The gap engine will read marketplace aggregates over a read-only credential
// added in a later phase. Prospect data and marketplace data never share a
// datastore — that separation is what keeps AI-inferred company data from
// ever reaching a public marketplace surface.

export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  CRAWL_QUEUE: Queue<CrawlMessage>;
  AI: Ai;

  CRAWLER_USER_AGENT: string;
  /** "true" enables unattended sending. Stays "false" until reply data earns it. */
  AUTOPILOT: string;
}

export interface CrawlMessage {
  companyId: string;
  domain: string;
  /** Which pages to attempt this pass. */
  kinds: ("home" | "sitemap" | "about" | "contact")[];
  attempt: number;
}
