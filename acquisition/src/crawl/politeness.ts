// Politeness scheduling: when may we next touch a given host?
//
// Pure decision functions, kept away from the fetch path so the rules can be
// tested directly. Nothing here performs I/O; callers persist the returned
// timestamp into crawl_jobs.next_eligible_at and honour it.

/** Floor between two requests to the same host when robots.txt is silent. */
export const DEFAULT_CRAWL_DELAY_MS = 2_000;

/** Never wait less than this, even if a site declares a smaller delay. */
export const MIN_CRAWL_DELAY_MS = 1_000;

/** Cap on declared crawl-delay — beyond this a host is effectively opting out. */
export const MAX_CRAWL_DELAY_MS = 30_000;

export const MAX_ATTEMPTS = 3;

export interface DelayInput {
  /** Value declared in robots.txt for our agent, if any. */
  declaredDelayMs: number | null;
}

/** Resolve the effective per-host delay, honouring a site's own request. */
export function effectiveDelayMs({ declaredDelayMs }: DelayInput): number {
  if (declaredDelayMs === null) return DEFAULT_CRAWL_DELAY_MS;
  return Math.min(MAX_CRAWL_DELAY_MS, Math.max(MIN_CRAWL_DELAY_MS, declaredDelayMs));
}

export interface BackoffInput {
  now: number;
  attempts: number;
  declaredDelayMs: number | null;
  /** Retry-After header value in seconds, when the server sent one. */
  retryAfterSeconds?: number | null;
}

/**
 * Next eligible time after a FAILED fetch: exponential backoff on the
 * effective delay, unless the server named its own Retry-After, which always
 * wins because it is an explicit instruction rather than our guess.
 */
export function backoffUntil({
  now,
  attempts,
  declaredDelayMs,
  retryAfterSeconds = null,
}: BackoffInput): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)) {
    return now + Math.max(0, retryAfterSeconds) * 1000;
  }
  const base = effectiveDelayMs({ declaredDelayMs });
  const factor = 2 ** Math.max(0, attempts);
  return now + Math.min(base * factor, 60 * 60 * 1000);
}

/** Next eligible time after a SUCCESSFUL fetch — just the polite gap. */
export function nextAfterSuccess(now: number, declaredDelayMs: number | null): number {
  return now + effectiveDelayMs({ declaredDelayMs });
}

export function shouldRetry(attempts: number, httpStatus: number | null): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  if (httpStatus === null) return true;            // network error
  if (httpStatus === 429) return true;             // rate limited
  if (httpStatus >= 500 && httpStatus < 600) return true;
  return false;                                     // 4xx: our problem, not transient
}

/**
 * Hosts we never crawl regardless of robots.txt: our own properties (no point)
 * and the platforms whose terms make automated collection inappropriate.
 * Kept as an explicit list so additions are a reviewable one-line change.
 */
const NEVER_CRAWL = [
  "buyhempflowernearme.com",
  "facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com",
  "tiktok.com", "pinterest.com", "youtube.com", "reddit.com",
  "amazon.com", "ebay.com", "etsy.com",
];

export function isCrawlableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return !NEVER_CRAWL.some((blocked) => host === blocked || host.endsWith("." + blocked));
}
