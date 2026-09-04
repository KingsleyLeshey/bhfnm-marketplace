import { describe, expect, it } from "vitest";
import { crawlDelayFor, isAllowed, parseRobots } from "../src/crawl/robots";

const UA = "BHFNM-AcquisitionBot/0.1";

describe("parseRobots", () => {
  it("collects sitemaps and groups", () => {
    const r = parseRobots(`
      Sitemap: https://example.com/sitemap.xml
      User-agent: *
      Disallow: /admin
      Crawl-delay: 5
    `);
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(r.groups).toHaveLength(1);
    expect(crawlDelayFor(r, UA)).toBe(5000);
  });

  it("ignores comments and blank lines", () => {
    const r = parseRobots("# comment\n\nUser-agent: *\nDisallow: /x # trailing");
    expect(isAllowed(r, UA, "/x")).toBe(false);
  });

  it("groups consecutive user-agent lines together", () => {
    const r = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /no");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.agents).toEqual(["a", "b"]);
  });
});

describe("isAllowed", () => {
  it("allows everything when robots.txt is empty", () => {
    expect(isAllowed(parseRobots(""), UA, "/anything")).toBe(true);
  });

  it("honours a blanket disallow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /");
    expect(isAllowed(r, UA, "/")).toBe(false);
    expect(isAllowed(r, UA, "/products")).toBe(false);
  });

  it("treats an empty Disallow as allow-all", () => {
    const r = parseRobots("User-agent: *\nDisallow:");
    expect(isAllowed(r, UA, "/anything")).toBe(true);
  });

  it("gives the longest match precedence", () => {
    const r = parseRobots("User-agent: *\nDisallow: /products\nAllow: /products/public");
    expect(isAllowed(r, UA, "/products/secret")).toBe(false);
    expect(isAllowed(r, UA, "/products/public/x")).toBe(true);
  });

  it("lets Allow win an equal-length tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
    expect(isAllowed(r, UA, "/a")).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.json$");
    expect(isAllowed(r, UA, "/data/file.json")).toBe(false);
    expect(isAllowed(r, UA, "/data/file.json.html")).toBe(true);
  });

  it("prefers the most specific matching agent group", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: bhfnm-acquisitionbot\nDisallow: /private"
    );
    expect(isAllowed(r, UA, "/catalog")).toBe(true);
    expect(isAllowed(r, UA, "/private/x")).toBe(false);
  });

  it("falls back to the wildcard group for unmatched agents", () => {
    const r = parseRobots("User-agent: googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /all");
    expect(isAllowed(r, UA, "/all")).toBe(false);
    expect(isAllowed(r, UA, "/g")).toBe(true);
  });

  it("does not let a rule before any user-agent line take effect", () => {
    const r = parseRobots("Disallow: /orphan\nUser-agent: *\nAllow: /");
    expect(isAllowed(r, UA, "/orphan")).toBe(true);
  });
});
