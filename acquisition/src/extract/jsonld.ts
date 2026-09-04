// JSON-LD extraction — the deterministic first pass.
//
// Hemp e-commerce runs overwhelmingly on Shopify and WooCommerce, and both
// emit schema.org Product / Organization markup by default. For most targets
// this yields catalog, price and identity data *exactly*, with no model call,
// no hallucination and no per-page cost. AI extraction runs only over what
// this pass could not find.

export interface JsonLdProduct {
  name: string;
  description?: string;
  sku?: string;
  brand?: string;
  category?: string;
  priceCents?: number;
  currency?: string;
  inStock?: boolean;
  url?: string;
  image?: string;
}

export interface JsonLdOrganization {
  name?: string;
  url?: string;
  email?: string;
  telephone?: string;
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
  sameAs?: string[];
}

export interface JsonLdHarvest {
  products: JsonLdProduct[];
  organization: JsonLdOrganization | null;
  /** Blocks that failed to parse — a signal the site is worth an AI pass. */
  malformedBlocks: number;
}

const SCRIPT_RE =
  /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Pull and JSON.parse every ld+json block, flattening @graph containers. */
export function extractJsonLdNodes(html: string): { nodes: unknown[]; malformed: number } {
  const nodes: unknown[] = [];
  let malformed = 0;

  for (const match of html.matchAll(SCRIPT_RE)) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformed++;
      continue;
    }
    for (const node of flatten(parsed)) nodes.push(node);
  }
  return { nodes, malformed };
}

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!isRecord(value)) return [];
  const graph = value["@graph"];
  if (graph !== undefined) return flatten(graph);
  return [value];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

/** schema.org prices arrive as "12.50", 12.5, or "$12.50" depending on plugin. */
export function parsePriceCents(value: unknown): number | undefined {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return undefined;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function firstOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const offers = node["offers"];
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    if (isRecord(o)) {
      // AggregateOffer nests the real offers one level down.
      if (typesOf(o).includes("aggregateoffer")) {
        const inner = o["offers"];
        const innerList = Array.isArray(inner) ? inner : [inner];
        for (const io of innerList) if (isRecord(io)) return io;
        return o;
      }
      return o;
    }
  }
  return null;
}

function availabilityToStock(value: unknown): boolean | undefined {
  const s = str(value)?.toLowerCase();
  if (!s) return undefined;
  if (s.includes("instock") || s.includes("in_stock")) return true;
  if (s.includes("outofstock") || s.includes("soldout") || s.includes("discontinued")) return false;
  return undefined;
}

function brandName(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (isRecord(value)) return str(value["name"]);
  return undefined;
}

export function harvestJsonLd(html: string): JsonLdHarvest {
  const { nodes, malformed } = extractJsonLdNodes(html);
  const products: JsonLdProduct[] = [];
  let organization: JsonLdOrganization | null = null;

  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const types = typesOf(node);

    if (types.includes("product")) {
      const name = str(node["name"]);
      if (!name) continue;
      const offer = firstOffer(node);
      const image = node["image"];
      products.push({
        name,
        description: str(node["description"]),
        sku: str(node["sku"]) ?? str(node["mpn"]),
        brand: brandName(node["brand"]),
        category: str(node["category"]),
        priceCents: offer ? parsePriceCents(offer["price"]) : undefined,
        currency: offer ? str(offer["priceCurrency"]) : undefined,
        inStock: offer ? availabilityToStock(offer["availability"]) : undefined,
        url: str(node["url"]) ?? (offer ? str(offer["url"]) : undefined),
        image: Array.isArray(image) ? str(image[0]) : str(image),
      });
      continue;
    }

    const isOrg =
      types.includes("organization") ||
      types.includes("localbusiness") ||
      types.includes("store") ||
      types.includes("onlinestore");

    if (isOrg && !organization) {
      const address = isRecord(node["address"]) ? node["address"] : {};
      const sameAs = node["sameAs"];
      organization = {
        name: str(node["name"]),
        url: str(node["url"]),
        email: str(node["email"]),
        telephone: str(node["telephone"]),
        streetAddress: str(address["streetAddress"]),
        addressLocality: str(address["addressLocality"]),
        addressRegion: str(address["addressRegion"]),
        postalCode: str(address["postalCode"]),
        addressCountry: str(address["addressCountry"]),
        sameAs: Array.isArray(sameAs)
          ? sameAs.filter((s): s is string => typeof s === "string")
          : typeof sameAs === "string"
            ? [sameAs]
            : undefined,
      };
    }
  }

  return { products, organization, malformedBlocks: malformed };
}
