import { describe, expect, it } from "vitest";
import {
  countInternalLinks,
  decodeEntities,
  detectBlogContent,
  detectCapabilities,
  extractEmails,
  extractMeta,
  extractPhones,
  extractSocialLinks,
  harvestHtml,
  parseAttributes,
} from "../src/extract/html";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("a&#64;b.com")).toBe("a@b.com");
    expect(decodeEntities("a&#x40;b.com")).toBe("a@b.com");
  });

  it("leaves unknown entities alone", () => {
    expect(decodeEntities("&notareal;")).toBe("&notareal;");
  });
});

describe("parseAttributes", () => {
  it("handles any quoting style and ordering", () => {
    expect(parseAttributes(`content="x" name='description'`)).toEqual({
      content: "x", name: "description",
    });
    expect(parseAttributes("charset=utf-8")).toEqual({ charset: "utf-8" });
  });
});

describe("extractMeta", () => {
  it("prefers og:title over <title>", () => {
    const html = `<title>Fallback</title><meta property="og:title" content="Real Title">`;
    expect(extractMeta(html).title).toBe("Real Title");
  });

  it("falls back to <title> and decodes it", () => {
    expect(extractMeta("<title>Blue Ridge &amp; Co</title>").title).toBe("Blue Ridge & Co");
  });

  it("reads description regardless of attribute order", () => {
    const html = `<meta content="Hemp farm in NC" name="description">`;
    expect(extractMeta(html).description).toBe("Hemp farm in NC");
  });

  it("reads site name and canonical", () => {
    const html = `<meta property="og:site_name" content="Acme Hemp">
                  <link rel="canonical" href="https://acme.com/">`;
    const meta = extractMeta(html);
    expect(meta.siteName).toBe("Acme Hemp");
    expect(meta.canonical).toBe("https://acme.com/");
  });

  it("returns nulls for a bare page", () => {
    expect(extractMeta("<html><body>hi</body></html>")).toEqual({
      title: null, description: null, siteName: null, canonical: null,
    });
  });
});

describe("extractEmails", () => {
  it("reads mailto links and strips query params", () => {
    const html = `<a href="mailto:wholesale@acme.com?subject=Hi">Wholesale</a>`;
    expect(extractEmails(html)).toEqual(["wholesale@acme.com"]);
  });

  it("reads addresses from visible text", () => {
    expect(extractEmails("<p>Reach us at info@acme.com today</p>")).toContain("info@acme.com");
  });

  it("decodes entity-encoded mailto addresses", () => {
    const html = `<a href="mailto:sales&#64;acme.com">mail</a>`;
    expect(extractEmails(html)).toContain("sales@acme.com");
  });

  it("ignores script and style contents", () => {
    const html = `<script>var t="tracking@segment.io";</script><p>info@acme.com</p>`;
    const emails = extractEmails(html);
    expect(emails).toContain("info@acme.com");
    expect(emails).not.toContain("tracking@segment.io");
  });

  it("does NOT de-obfuscate [at] style addresses", () => {
    // Obfuscation signals the site does not want automated harvesting.
    expect(extractEmails("<p>info [at] acme [dot] com</p>")).toEqual([]);
  });

  it("deduplicates and lowercases", () => {
    const html = `<a href="mailto:Info@Acme.com">a</a><p>info@acme.com</p>`;
    expect(extractEmails(html)).toEqual(["info@acme.com"]);
  });
});

describe("extractPhones", () => {
  it("reads tel links", () => {
    expect(extractPhones(`<a href="tel:+1-555-010-9999">call</a>`)).toEqual(["+15550109999"]);
  });

  it("rejects fragments too short to be numbers", () => {
    expect(extractPhones(`<a href="tel:123">x</a>`)).toEqual([]);
  });
});

describe("extractSocialLinks", () => {
  it("captures known platforms", () => {
    const html = `<a href="https://instagram.com/acmehemp">ig</a>
                  <a href="https://www.linkedin.com/company/acme">li</a>`;
    const links = extractSocialLinks(html);
    expect(links.instagram).toContain("instagram.com/acmehemp");
    expect(links.linkedin).toContain("linkedin.com/company/acme");
  });

  it("normalizes protocol-relative urls", () => {
    expect(extractSocialLinks(`<a href="//x.com/acme">x</a>`).x).toBe("https://x.com/acme");
  });

  it("returns empty when there are none", () => {
    expect(extractSocialLinks("<p>nothing</p>")).toEqual({});
  });
});

describe("detectCapabilities", () => {
  it("detects wholesale and private label", () => {
    const c = detectCapabilities("<a>Wholesale Program</a><p>We offer white label services</p>");
    expect(c.wholesale).toBe(true);
    expect(c.privateLabel).toBe(true);
  });

  it("detects a lab-results section as a site signal only", () => {
    expect(detectCapabilities("<a>Certificates of Analysis</a>").publishesLabResults).toBe(true);
    expect(detectCapabilities("<a>Lab Results</a>").publishesLabResults).toBe(true);
  });

  it("reports false when signals are absent", () => {
    const c = detectCapabilities("<p>We sell flower.</p>");
    expect(c).toEqual({
      wholesale: false, privateLabel: false,
      publishesLabResults: false, shipsNationwide: false,
    });
  });
});

describe("countInternalLinks", () => {
  it("counts distinct same-host paths", () => {
    const html = `<a href="/shop">s</a><a href="/about">a</a><a href="/shop">dup</a>
                  <a href="https://acme.com/blog">b</a>`;
    expect(countInternalLinks(html, "acme.com")).toBe(3);
  });

  it("ignores external links, anchors and mailto", () => {
    const html = `<a href="https://other.com/x">o</a><a href="#top">t</a>
                  <a href="mailto:a@b.com">m</a><a href="/only">y</a>`;
    expect(countInternalLinks(html, "acme.com")).toBe(1);
  });

  it("treats www and bare host as the same site", () => {
    expect(countInternalLinks(`<a href="https://www.acme.com/p">p</a>`, "acme.com")).toBe(1);
  });

  it("ignores query strings when counting distinct pages", () => {
    const html = `<a href="/shop?page=1">a</a><a href="/shop?page=2">b</a>`;
    expect(countInternalLinks(html, "acme.com")).toBe(1);
  });
});

describe("detectBlogContent", () => {
  it("spots content sections", () => {
    expect(detectBlogContent(`<a href="/blog/thca-guide">g</a>`)).toBe(true);
    expect(detectBlogContent(`<a href="/learn/what-is-cbg">l</a>`)).toBe(true);
    expect(detectBlogContent(`<a href="/shop">s</a>`)).toBe(false);
  });
});

describe("harvestHtml", () => {
  it("assembles a full harvest", () => {
    const html = `<title>Acme Hemp</title>
      <meta name="description" content="Farm direct hemp">
      <a href="mailto:wholesale@acme.com">Wholesale</a>
      <a href="/shop">Shop</a><a href="/blog/x">Blog</a>
      <a href="https://instagram.com/acme">ig</a>
      <p>Bulk pricing available. Lab results on every batch.</p>`;
    const h = harvestHtml(html, "https://acme.com/");
    expect(h.meta.title).toBe("Acme Hemp");
    expect(h.emails).toContain("wholesale@acme.com");
    expect(h.capabilities.wholesale).toBe(true);
    expect(h.capabilities.publishesLabResults).toBe(true);
    expect(h.hasBlogContent).toBe(true);
    expect(h.internalLinkCount).toBe(2);
    expect(h.socialLinks.instagram).toBeDefined();
  });

  it("survives a malformed page url", () => {
    expect(harvestHtml("<title>x</title>", "not a url").internalLinkCount).toBe(0);
  });
});
