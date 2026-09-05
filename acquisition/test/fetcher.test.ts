import { describe, expect, it } from "vitest";
import {
  MAX_PAGES_PER_COMPANY, crawlCompany, fetchRobots, rawKey, sha256Hex,
  type CrawlDeps, type RawStore,
} from "../src/crawl/fetcher";

const NOW = 1_700_000_000_000;

/** Build a deps object from a map of url → response spec. */
function deps(
  routes: Record<string, { status?: number; body?: string; headers?: Record<string, string>; throws?: boolean }>
): CrawlDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => NOW,
    userAgent: "BHFNM-AcquisitionBot/0.1",
    async fetch(url) {
      calls.push(url);
      const route = routes[url];
      if (!route) return response(404, "");
      if (route.throws) throw new Error("network down");
      return response(route.status ?? 200, route.body ?? "", route.headers);
    },
  };
}

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

function store(): RawStore & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return { written, async put(key, value) { written.set(key, value); return undefined; } };
}

describe("sha256Hex / rawKey", () => {
  it("hashes deterministically", async () => {
    expect(await sha256Hex("hello")).toBe(await sha256Hex("hello"));
    expect(await sha256Hex("hello")).not.toBe(await sha256Hex("world"));
  });

  it("namespaces raw keys by domain and page kind", () => {
    expect(rawKey("acme.com", "home", "abc")).toBe("raw/acme.com/home/abc.html");
  });
});

describe("fetchRobots", () => {
  it("parses rules and the declared crawl delay", async () => {
    const d = deps({
      "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /admin\nCrawl-delay: 4" },
    });
    const r = await fetchRobots(d, "acme.com");
    expect(r.rootAllowed).toBe(true);
    expect(r.delayMs).toBe(4000);
  });

  it("treats a missing robots.txt as no rules", async () => {
    const r = await fetchRobots(deps({}), "acme.com");
    expect(r.rootAllowed).toBe(true);
    expect(r.status).toBe(404);
  });

  it("survives a network failure without granting permission implicitly", async () => {
    const r = await fetchRobots(deps({ "https://acme.com/robots.txt": { throws: true } }), "acme.com");
    expect(r.status).toBeNull();
    expect(r.rootAllowed).toBe(true);   // no rules known == default allow
  });

  it("detects a blanket disallow", async () => {
    const d = deps({ "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /" } });
    expect((await fetchRobots(d, "acme.com")).rootAllowed).toBe(false);
  });
});

describe("crawlCompany — gates", () => {
  it("refuses a never-crawl host without any network call", async () => {
    const d = deps({});
    const out = await crawlCompany(d, store(), { domain: "instagram.com", attempts: 0 });
    expect(out.status).toBe("blocked");
    expect(out.error).toBe("host_not_crawlable");
    expect(d.calls).toHaveLength(0);
  });

  it("stops at a blanket robots disallow and fetches no content page", async () => {
    const d = deps({
      "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /" },
      "https://acme.com/": { body: "<html>secret</html>" },
    });
    const out = await crawlCompany(d, store(), { domain: "acme.com", attempts: 0 });
    expect(out.status).toBe("blocked");
    expect(out.robotsAllowed).toBe(false);
    expect(d.calls).toEqual(["https://acme.com/robots.txt"]);
  });

  it("checks robots per path, not just at the root", async () => {
    const d = deps({
      "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /contact" },
      "https://acme.com/": { body: "<html>home</html>" },
      "https://acme.com/contact": { body: "<html>contact</html>" },
    });
    await crawlCompany(d, store(), { domain: "acme.com", attempts: 0 });
    expect(d.calls).toContain("https://acme.com/");
    expect(d.calls).not.toContain("https://acme.com/contact");
  });

  it("always reads robots.txt before any content url", async () => {
    const d = deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/": { body: "<html>home</html>" },
    });
    await crawlCompany(d, store(), { domain: "acme.com", attempts: 0 });
    expect(d.calls[0]).toBe("https://acme.com/robots.txt");
  });
});

describe("crawlCompany — success path", () => {
  const okRoutes = {
    "https://acme.com/robots.txt": { body: "User-agent: *\nCrawl-delay: 3" },
    "https://acme.com/": { body: "<html>home</html>" },
    "https://acme.com/about": { body: "<html>about</html>" },
    "https://acme.com/contact": { body: "<html>contact</html>" },
  };

  it("fetches pages, stores raw html in R2 and reports them", async () => {
    const r2 = store();
    const out = await crawlCompany(deps(okRoutes), r2, { domain: "acme.com", attempts: 0 });

    expect(out.status).toBe("done");
    expect(out.pages.map((p) => p.kind).sort()).toEqual(["about", "contact", "home"]);
    expect(r2.written.size).toBe(3);
    expect([...r2.written.values()]).toContain("<html>home</html>");
  });

  it("honours the declared crawl delay when scheduling the next visit", async () => {
    const out = await crawlCompany(deps(okRoutes), store(), { domain: "acme.com", attempts: 0 });
    expect(out.crawlDelayMs).toBe(3000);
    expect(out.nextEligibleAt).toBe(NOW + 3000);
  });

  it("skips duplicate pages served under different paths", async () => {
    const same = "<html>identical</html>";
    const out = await crawlCompany(deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/about": { body: same },
      "https://acme.com/about-us": { body: same },
    }), store(), { domain: "acme.com", attempts: 0 });
    expect(out.pages).toHaveLength(1);
  });

  it("treats a 404 on an optional page as normal, not a failure", async () => {
    const out = await crawlCompany(deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/": { body: "<html>home</html>" },
    }), store(), { domain: "acme.com", attempts: 0 });
    expect(out.status).toBe("done");
    expect(out.error).toBeNull();
    expect(out.pages).toHaveLength(1);
  });

  it("caps how many pages it takes from one company", async () => {
    const routes: Record<string, { body: string }> = {
      "https://acme.com/robots.txt": { body: "" },
    };
    // Give every planned path unique content so none dedupe away.
    for (const p of ["/", "/sitemap.xml", "/wholesale", "/pages/wholesale", "/about", "/about-us", "/contact", "/contact-us"]) {
      routes[`https://acme.com${p}`] = { body: `<html>${p}</html>` };
    }
    const out = await crawlCompany(deps(routes), store(), { domain: "acme.com", attempts: 0 });
    expect(out.pages).toHaveLength(MAX_PAGES_PER_COMPANY);
  });
});

describe("crawlCompany — failure handling", () => {
  it("backs off on a 503 and marks the job retryable", async () => {
    const out = await crawlCompany(deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/": { status: 503, body: "" },
    }), store(), { domain: "acme.com", attempts: 0 });

    expect(out.status).toBe("failed");
    expect(out.error).toBe("http_503");
    expect(out.nextEligibleAt).toBeGreaterThan(NOW);
  });

  it("obeys Retry-After over its own backoff guess", async () => {
    const out = await crawlCompany(deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/": { status: 429, body: "", headers: { "retry-after": "300" } },
    }), store(), { domain: "acme.com", attempts: 0 });
    expect(out.nextEligibleAt).toBe(NOW + 300_000);
  });

  it("stops retrying once the attempt ceiling is reached", async () => {
    const out = await crawlCompany(deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/": { status: 503, body: "" },
    }), store(), { domain: "acme.com", attempts: 3 });
    expect(out.status).toBe("blocked");
  });

  it("records a network error as a retryable failure", async () => {
    const out = await crawlCompany(deps({
      "https://acme.com/robots.txt": { body: "" },
      "https://acme.com/": { throws: true },
    }), store(), { domain: "acme.com", attempts: 0 });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("network down");
  });

  it("increments the attempt counter every run", async () => {
    const out = await crawlCompany(deps({ "https://acme.com/robots.txt": { body: "" } }),
      store(), { domain: "acme.com", attempts: 1 });
    expect(out.attempts).toBe(2);
  });

  it("does not write to R2 when nothing was fetched", async () => {
    const r2 = store();
    await crawlCompany(deps({ "https://acme.com/robots.txt": { body: "" } }), r2, { domain: "acme.com", attempts: 0 });
    expect(r2.written.size).toBe(0);
  });
});
