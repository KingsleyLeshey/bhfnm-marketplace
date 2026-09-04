// Acquisition Worker entry point.
//
// Three surfaces:
//   fetch     — internal API + dashboard, fronted by Cloudflare Access
//   queue     — the crawl/extract consumer (the async substrate)
//   scheduled — periodic acquisition waves
//
// Access is enforced at the edge by Cloudflare Access, not in this code, so
// there is deliberately no auth logic here to get wrong. Do not expose this
// Worker on a route that Access does not cover.

import type { CrawlMessage, Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        bindings: {
          db: Boolean(env.DB),
          raw: Boolean(env.RAW),
          queue: Boolean(env.CRAWL_QUEUE),
          ai: Boolean(env.AI),
        },
        autopilot: env.AUTOPILOT === "true",
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<CrawlMessage>, _env: Env): Promise<void> {
    // Crawl consumer lands in the next build pass. Retry semantics are already
    // declared in wrangler.toml (3 attempts, then the dead-letter queue).
    for (const message of batch.messages) {
      message.retry();
    }
  },

  async scheduled(_event: ScheduledController, _env: Env): Promise<void> {
    // Acquisition wave: recompute supply gaps, generate queries, enqueue crawls.
    // Built in the next pass.
  },
};
