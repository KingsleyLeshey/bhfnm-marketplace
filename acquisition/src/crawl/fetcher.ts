// The crawler.
//
// Order of operations is the whole point of this file:
//   robots.txt  →  politeness gate  →  fetch  →  raw to R2  →  row in D1
//
// Nothing fetches a content URL before robots.txt has been read and the
// politeness window has opened. `fetch` and the clock are injected so the
// whole flow is testable without a network — which matters here, because the
// build environment has no outbound web access at all.

import { ALLOW_ALL, crawlDelayFor, isAllowed, parseRobots, type Robots } from "./robots";
import {
  backoffUntil, effectiveDelayMs, isCrawlableHost, nextAfterSuccess, shouldRetry,
} from "./politeness";
import type { PageKind } from "../db/queries";

export interface CrawlDeps {
  fetch: (url: string, init?: { headers?: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;
  now(): number;
  userAgent: string;
}

export interface RawStore {
  put(key: string, value: string): Promise<unknown>;
}

/** Pages worth trying, in priority order. Each is robots-checked individually. */
export const PAGE_PLAN: { path: string; kind: PageKind }[] = [
  { path: "/", kind: "home" },
  { path: "/sitemap.xml", kind: "sitemap" },
  { path: "/wholesale", kind: "other" },
  { path: "/pages/wholesale", kind: "other" },   // Shopify convention
  { path: "/about", kind: "about" },
  { path: "/about-us", kind: "about" },
  { path: "/contact", kind: "contact" },
  { path: "/contact-us", kind: "contact" },
];

/** Stop after this many successful pages — enough to profile, not a full spider. */
export const MAX_PAGES_PER_COMPANY = 6;

export interface RobotsOutcome {
  robots: Robots;
  delayMs: number;
  /** False only when the site's own robots.txt disallows our agent at the root. */
  rootAllowed: boolean;
  status: number | null;
}

/**
 * Fetch and parse robots.txt. A 404 or an unreachable file means "no rules",
 * which is the standard interpretation — but a network failure is NOT treated
 * as permission, it is treated as no rules only after the request completes.
 */
export async function fetchRobots(deps: CrawlDeps, domain: string): Promise<RobotsOutcome> {
  const url = `https://${domain}/robots.txt`;
  let robots: Robots = ALLOW_ALL;
  let status: number | null = null;

  try {
    const res = await deps.fetch(url, { headers: { "user-agent": deps.userAgent } });
    status = res.status;
    if (res.ok) robots = parseRobots(await res.text());
  } catch {
    status = null;
  }

  return {
    robots,
    delayMs: effectiveDelayMs({ declaredDelayMs: crawlDelayFor(robots, deps.userAgent) }),
    rootAllowed: isAllowed(robots, deps.userAgent, "/"),
    status,
  };
}

export interface FetchedPage {
  url: string;
  kind: PageKind;
  status: number;
  html: string;
  contentHash: string;
  bytes: number;
  r2Key: string;
}

export interface CrawlOutcome {
  status: "done" | "failed" | "blocked";
  pages: FetchedPage[];
  /** Politeness-aware time the next attempt on this host may happen. */
  nextEligibleAt: number;
  attempts: number;
  robotsAllowed: boolean | null;
  crawlDelayMs: number | null;
  error: string | null;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function rawKey(domain: string, kind: PageKind, hash: string): string {
  return `raw/${domain}/${kind}/${hash}.html`;
}

function retryAfterSeconds(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const n = Number.parseInt(headerValue, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Crawl one company. Returns everything the caller needs to persist; this
 * function performs no database writes itself, so it stays testable and the
 * transaction boundary lives with the caller.
 */
export async function crawlCompany(
  deps: CrawlDeps,
  raw: RawStore,
  input: { domain: string; attempts: number }
): Promise<CrawlOutcome> {
  const { domain } = input;
  const attempts = input.attempts + 1;

  // Gate 1: hosts we never touch, regardless of what robots.txt says.
  if (!isCrawlableHost(domain)) {
    return {
      status: "blocked", pages: [], nextEligibleAt: Number.MAX_SAFE_INTEGER,
      attempts, robotsAllowed: null, crawlDelayMs: null,
      error: "host_not_crawlable",
    };
  }

  // Gate 2: the site's own robots.txt.
  const robotsOutcome = await fetchRobots(deps, domain);
  if (!robotsOutcome.rootAllowed) {
    return {
      status: "blocked", pages: [], nextEligibleAt: Number.MAX_SAFE_INTEGER,
      attempts, robotsAllowed: false, crawlDelayMs: robotsOutcome.delayMs,
      error: "robots_disallowed",
    };
  }

  const pages: FetchedPage[] = [];
  const seenHashes = new Set<string>();
  let lastError: string | null = null;
  let transientFailure = false;
  let retryAfter: number | null = null;

  for (const step of PAGE_PLAN) {
    if (pages.length >= MAX_PAGES_PER_COMPANY) break;

    // Gate 3: per-path robots check. A site may allow / but disallow /contact.
    if (!isAllowed(robotsOutcome.robots, deps.userAgent, step.path)) continue;

    const url = `https://${domain}${step.path}`;
    try {
      const res = await deps.fetch(url, { headers: { "user-agent": deps.userAgent } });

      if (!res.ok) {
        // 404 on an optional page is expected, not a failure of the crawl.
        if (res.status === 404 || res.status === 410) continue;
        lastError = `http_${res.status}`;
        if (shouldRetry(input.attempts, res.status)) {
          transientFailure = true;
          retryAfter = retryAfterSeconds(res.headers.get("retry-after"));
          break;
        }
        continue;
      }

      const html = await res.text();
      const contentHash = await sha256Hex(html);
      // Many sites serve the same page for /about and /about-us.
      if (seenHashes.has(contentHash)) continue;
      seenHashes.add(contentHash);

      const key = rawKey(domain, step.kind, contentHash);
      await raw.put(key, html);

      pages.push({
        url, kind: step.kind, status: res.status, html,
        contentHash, bytes: html.length, r2Key: key,
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : "fetch_failed";
      transientFailure = true;
      break;
    }
  }

  const now = deps.now();

  if (pages.length === 0) {
    const failed = transientFailure || lastError !== null;
    return {
      status: failed && shouldRetry(input.attempts, null) ? "failed" : "blocked",
      pages: [],
      nextEligibleAt: failed
        ? backoffUntil({ now, attempts: input.attempts, declaredDelayMs: robotsOutcome.delayMs, retryAfterSeconds: retryAfter })
        : Number.MAX_SAFE_INTEGER,
      attempts,
      robotsAllowed: true,
      crawlDelayMs: robotsOutcome.delayMs,
      error: lastError ?? "no_pages_fetched",
    };
  }

  return {
    status: transientFailure ? "failed" : "done",
    pages,
    nextEligibleAt: transientFailure
      ? backoffUntil({ now, attempts: input.attempts, declaredDelayMs: robotsOutcome.delayMs, retryAfterSeconds: retryAfter })
      : nextAfterSuccess(now, robotsOutcome.delayMs),
    attempts,
    robotsAllowed: true,
    crawlDelayMs: robotsOutcome.delayMs,
    error: transientFailure ? lastError : null,
  };
}
