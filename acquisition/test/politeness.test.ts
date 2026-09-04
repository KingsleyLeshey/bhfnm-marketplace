import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRAWL_DELAY_MS,
  MAX_CRAWL_DELAY_MS,
  MIN_CRAWL_DELAY_MS,
  backoffUntil,
  effectiveDelayMs,
  isCrawlableHost,
  nextAfterSuccess,
  shouldRetry,
} from "../src/crawl/politeness";

describe("effectiveDelayMs", () => {
  it("uses the default when robots.txt is silent", () => {
    expect(effectiveDelayMs({ declaredDelayMs: null })).toBe(DEFAULT_CRAWL_DELAY_MS);
  });

  it("honours a declared delay", () => {
    expect(effectiveDelayMs({ declaredDelayMs: 5000 })).toBe(5000);
  });

  it("never goes below the floor even if a site asks for less", () => {
    expect(effectiveDelayMs({ declaredDelayMs: 10 })).toBe(MIN_CRAWL_DELAY_MS);
  });

  it("caps absurd declared delays", () => {
    expect(effectiveDelayMs({ declaredDelayMs: 600_000 })).toBe(MAX_CRAWL_DELAY_MS);
  });
});

describe("backoffUntil", () => {
  it("grows exponentially with attempts", () => {
    const now = 1_000_000;
    const first = backoffUntil({ now, attempts: 0, declaredDelayMs: null });
    const second = backoffUntil({ now, attempts: 1, declaredDelayMs: null });
    const third = backoffUntil({ now, attempts: 2, declaredDelayMs: null });
    expect(second - now).toBe((first - now) * 2);
    expect(third - now).toBe((first - now) * 4);
  });

  it("lets an explicit Retry-After win over our own guess", () => {
    const now = 5_000;
    expect(backoffUntil({ now, attempts: 3, declaredDelayMs: null, retryAfterSeconds: 120 }))
      .toBe(now + 120_000);
  });

  it("caps backoff at one hour", () => {
    const now = 0;
    expect(backoffUntil({ now, attempts: 50, declaredDelayMs: null })).toBe(60 * 60 * 1000);
  });
});

describe("nextAfterSuccess", () => {
  it("waits the polite gap", () => {
    expect(nextAfterSuccess(1000, 3000)).toBe(4000);
  });
});

describe("shouldRetry", () => {
  it("retries network errors and 5xx", () => {
    expect(shouldRetry(0, null)).toBe(true);
    expect(shouldRetry(1, 503)).toBe(true);
  });

  it("retries 429", () => {
    expect(shouldRetry(0, 429)).toBe(true);
  });

  it("does not retry other 4xx", () => {
    expect(shouldRetry(0, 404)).toBe(false);
    expect(shouldRetry(0, 403)).toBe(false);
  });

  it("stops at the attempt ceiling", () => {
    expect(shouldRetry(3, 500)).toBe(false);
  });
});

describe("isCrawlableHost", () => {
  it("refuses our own domain", () => {
    expect(isCrawlableHost("buyhempflowernearme.com")).toBe(false);
    expect(isCrawlableHost("www.buyhempflowernearme.com")).toBe(false);
  });

  it("refuses social and major platforms, including subdomains", () => {
    expect(isCrawlableHost("instagram.com")).toBe(false);
    expect(isCrawlableHost("business.facebook.com")).toBe(false);
    expect(isCrawlableHost("www.amazon.com")).toBe(false);
  });

  it("allows ordinary seller sites", () => {
    expect(isCrawlableHost("blueridgehempco.com")).toBe(true);
    expect(isCrawlableHost("shop.somehempfarm.co")).toBe(true);
  });

  it("does not match a lookalike suffix", () => {
    expect(isCrawlableHost("notamazon.com")).toBe(true);
  });
});
