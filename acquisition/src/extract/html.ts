// HTML fallback extraction — the second deterministic pass.
//
// Runs over pages where JSON-LD gave us nothing, or gave us only part of the
// picture. Everything here is still deterministic parsing: no model, no
// guessing. Whatever this pass cannot find is what the AI pass is *for*.
//
// Deliberately regex-based rather than DOM-based so it stays a pure function
// with no runtime dependency — it can be exhaustively unit tested, and the
// same code runs identically in a Worker and in vitest.
//
// One deliberate omission: this does NOT de-obfuscate addresses written as
// "name [at] example [dot] com". That pattern is a site explicitly signalling
// it does not want automated harvesting, and honouring it costs us nothing.
// Standard HTML entity decoding is different — that is just parsing what a
// browser would render.

export interface MetaFacts {
  title: string | null;
  description: string | null;
  siteName: string | null;
  canonical: string | null;
}

/**
 * Merchandising and business-model signals only.
 *
 * `publishesLabResults` means "this site has a lab-results/COA section" — a
 * signal about how organised a supplier is. It is NOT a compliance
 * determination, and nothing downstream may treat it as one. Verified COA
 * status comes from documents a human checked, never from a page's nav bar.
 */
export interface CapabilitySignals {
  wholesale: boolean;
  privateLabel: boolean;
  publishesLabResults: boolean;
  shipsNationwide: boolean;
}

export interface HtmlHarvest {
  meta: MetaFacts;
  /** Raw addresses, unfiltered. contacts.ts decides which may be kept. */
  emails: string[];
  phones: string[];
  socialLinks: Record<string, string>;
  capabilities: CapabilitySignals;
  internalLinkCount: number;
  hasBlogContent: boolean;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&quot;": '"', "&apos;": "'", "&#39;": "'",
  "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

/** Parse a tag's attributes. Handles quoting styles and arbitrary ordering. */
export function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of tag.matchAll(re)) {
    const key = m[1]!.toLowerCase();
    attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function metaTags(html: string): Record<string, string>[] {
  return [...html.matchAll(/<meta\b([^>]*)>/gi)].map((m) => parseAttributes(m[1] ?? ""));
}

export function extractMeta(html: string): MetaFacts {
  const tags = metaTags(html);

  const byKey = (key: "name" | "property", value: string): string | null => {
    for (const tag of tags) {
      if (tag[key]?.toLowerCase() === value) {
        const content = tag["content"]?.trim();
        if (content) return content;
      }
    }
    return null;
  };

  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    byKey("property", "og:title") ??
    (titleTag ? decodeEntities(titleTag[1]!).trim() || null : null);

  const canonicalTag = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .map((m) => parseAttributes(m[1] ?? ""))
    .find((a) => a["rel"]?.toLowerCase() === "canonical");

  return {
    title,
    description: byKey("name", "description") ?? byKey("property", "og:description"),
    siteName: byKey("property", "og:site_name"),
    canonical: canonicalTag?.["href"] ?? null,
  };
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g;

/**
 * Addresses from `mailto:` links and from visible page text. Returned raw and
 * deduplicated; the role/personal decision belongs to contacts.ts so that the
 * privacy rule lives in exactly one place.
 */
export function extractEmails(html: string): string[] {
  const found = new Set<string>();

  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"']+)["']/gi)) {
    const address = decodeEntities(m[1]!).split("?")[0]!.trim().toLowerCase();
    if (EMAIL_RE.test(address)) found.add(address);
    EMAIL_RE.lastIndex = 0;
  }

  // Strip scripts and styles first — they are full of things shaped like
  // addresses (analytics ids, CSS selectors) that are not contacts.
  const visible = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
  for (const m of visible.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());

  return [...found];
}

export function extractPhones(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const raw = decodeEntities(m[1]!).replace(/[^\d+]/g, "");
    if (raw.replace(/\D/g, "").length >= 7) found.add(raw);
  }
  return [...found];
}

const SOCIAL_HOSTS: [string, RegExp][] = [
  ["instagram", /(?:https?:)?\/\/(?:www\.)?instagram\.com\/[^"'\s>?]+/i],
  ["facebook", /(?:https?:)?\/\/(?:www\.)?facebook\.com\/[^"'\s>?]+/i],
  ["x", /(?:https?:)?\/\/(?:www\.)?(?:twitter|x)\.com\/[^"'\s>?]+/i],
  ["linkedin", /(?:https?:)?\/\/(?:www\.)?linkedin\.com\/[^"'\s>?]+/i],
  ["youtube", /(?:https?:)?\/\/(?:www\.)?youtube\.com\/[^"'\s>?]+/i],
  ["tiktok", /(?:https?:)?\/\/(?:www\.)?tiktok\.com\/[^"'\s>?]+/i],
];

/** Social presence is a brand-strength signal. We never crawl these hosts. */
export function extractSocialLinks(html: string): Record<string, string> {
  const links: Record<string, string> = {};
  for (const [platform, re] of SOCIAL_HOSTS) {
    const m = html.match(re);
    if (m) links[platform] = m[0].startsWith("//") ? "https:" + m[0] : m[0];
  }
  return links;
}

const CAPABILITY_PATTERNS: [keyof CapabilitySignals, RegExp][] = [
  ["wholesale", /\bwholesale\b|\bb2b\b|\bbulk\s+order|\bbulk\s+pricing|\btrade\s+account|\bresell(er|ing)\b/i],
  ["privateLabel", /\bprivate\s*label\b|\bwhite\s*label\b|\bcustom\s+branding\b|\bcontract\s+manufactur/i],
  ["publishesLabResults", /\blab\s*results?\b|\bcertificates?\s+of\s+analysis\b|\bcoas?\b|\bthird[\s-]party\s+test/i],
  ["shipsNationwide", /\bship\s+(?:to\s+)?all\s+50\b|\bnationwide\s+shipping\b|\bfree\s+shipping\b/i],
];

export function detectCapabilities(html: string): CapabilitySignals {
  const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
  const signals: CapabilitySignals = {
    wholesale: false, privateLabel: false,
    publishesLabResults: false, shipsNationwide: false,
  };
  for (const [key, pattern] of CAPABILITY_PATTERNS) {
    signals[key] = pattern.test(text);
  }
  return signals;
}

/** Rough site-depth signal feeding seoOpportunity(). Same-host links only. */
export function countInternalLinks(html: string, host: string): number {
  const bare = host.toLowerCase().replace(/^www\./, "");
  const paths = new Set<string>();

  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeEntities(m[1]!).trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;

    if (href.startsWith("/") && !href.startsWith("//")) {
      paths.add(href.split(/[?#]/)[0]!);
      continue;
    }
    try {
      const url = new URL(href.startsWith("//") ? "https:" + href : href);
      if (url.hostname.toLowerCase().replace(/^www\./, "") === bare) {
        paths.add(url.pathname);
      }
    } catch {
      // Relative or malformed href — not a countable internal page.
    }
  }
  return paths.size;
}

export function detectBlogContent(html: string): boolean {
  return /href\s*=\s*["'][^"']*\/(blog|news|articles|guides|learn|journal)\b/i.test(html);
}

export function harvestHtml(html: string, pageUrl: string): HtmlHarvest {
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    host = "";
  }
  return {
    meta: extractMeta(html),
    emails: extractEmails(html),
    phones: extractPhones(html),
    socialLinks: extractSocialLinks(html),
    capabilities: detectCapabilities(html),
    internalLinkCount: host ? countInternalLinks(html, host) : 0,
    hasBlogContent: detectBlogContent(html),
  };
}
