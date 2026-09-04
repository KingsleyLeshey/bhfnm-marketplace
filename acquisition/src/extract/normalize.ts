// Product normalization — map a seller's own wording onto the marketplace
// taxonomy so catalogs become comparable across sellers.
//
// Targets are the marketplace's existing enums, deliberately: one vocabulary
// from prospect through onboarding means a converted seller keeps its
// classification with no mapping layer.
//
//   cannabinoid_type: cbd | cbg | cbn | thca | delta9_hemp | delta8 | hhc | mixed | none
//   category slugs:   hemp-flower, cbd-flower, cbg-flower, thca-flower,
//                     pre-rolls, thc-drinks, gummies, vapes, tinctures,
//                     cbn-sleep, wellness, accessories
//
// HARD RULE: this module infers *merchandising* facts only — what kind of
// product something is. It never infers regulated or compliance facts.
// Potency, COA status, legality and batch data are not derived from marketing
// copy, ever. Those come from documents a human verified.

export type Cannabinoid =
  | "cbd" | "cbg" | "cbn" | "thca" | "delta9_hemp" | "delta8" | "hhc" | "mixed" | "none";

export type ProductForm =
  | "flower" | "pre_roll" | "gummy" | "vape" | "tincture" | "drink"
  | "topical" | "concentrate" | "accessory" | "unknown";

export interface NormalizedProduct {
  cannabinoid: Cannabinoid;
  form: ProductForm;
  categorySlug: string | null;
  weightGrams: number | null;
  pricePerGram: number | null;
}

const GRAMS_PER_OUNCE = 28.3495;
const GRAMS_PER_POUND = 453.592;

/**
 * Cannabinoid detection. Order matters: "THCA" must be tested before "THC",
 * and the delta variants before the bare cannabinoid names, or every THCA
 * flower listing classifies as generic THC.
 */
const CANNABINOID_PATTERNS: [Cannabinoid, RegExp][] = [
  ["thca", /\bthc[\s-]?a\b|\bthca\b/i],
  ["delta8", /\bdelta[\s-]?8\b|\bd8\b|\b∆8\b/i],
  ["hhc", /\bhhc\b/i],
  ["delta9_hemp", /\bdelta[\s-]?9\b|\bd9\b|\b∆9\b/i],
  ["cbn", /\bcbn\b/i],
  ["cbg", /\bcbg\b/i],
  ["cbd", /\bcbd\b/i],
];

const FORM_PATTERNS: [ProductForm, RegExp][] = [
  ["pre_roll", /\bpre[\s-]?rolls?\b|\bjoints?\b|\bblunts?\b|\bcigarettes?\b/i],
  ["gummy", /\bgumm(y|ies)\b|\bchews?\b|\bedibles?\b/i],
  ["vape", /\bvapes?\b|\bcarts?\b|\bcartridges?\b|\bdisposables?\b|\bpens?\b/i],
  ["drink", /\bdrinks?\b|\bseltzers?\b|\bbeverages?\b|\bsodas?\b|\bshots?\b/i],
  ["tincture", /\btinctures?\b|\boils?\b|\bdrops?\b|\bsublinguals?\b/i],
  ["topical", /\btopicals?\b|\bbalms?\b|\bsalves?\b|\bcreams?\b|\blotions?\b/i],
  ["concentrate", /\bconcentrates?\b|\brosin\b|\bwax\b|\bshatter\b|\bdabs?\b|\bhash\b/i],
  ["accessory", /\bgrinders?\b|\bpapers?\b|\bpipes?\b|\blighters?\b|\btrays?\b|\bstorage\b/i],
  ["flower", /\bflowers?\b|\bbuds?\b|\bnugs?\b|\bstrains?\b|\bsmalls?\b|\bshake\b|\btrim\b/i],
];

export function detectCannabinoid(text: string): Cannabinoid {
  const found: Cannabinoid[] = [];
  for (const [cannabinoid, pattern] of CANNABINOID_PATTERNS) {
    if (pattern.test(text)) found.push(cannabinoid);
  }
  if (found.length === 0) return "none";
  if (found.length === 1) return found[0]!;
  // A "CBD + CBN sleep blend" is genuinely mixed; say so rather than picking.
  return "mixed";
}

export function detectForm(text: string): ProductForm {
  for (const [form, pattern] of FORM_PATTERNS) {
    if (pattern.test(text)) return form;
  }
  return "unknown";
}

/**
 * Weight parsing. Handles "3.5g", "1 oz", "1/8 oz", "28 grams", "1lb",
 * and the fractional shorthand the flower trade actually uses.
 */
export function parseWeightGrams(text: string): number | null {
  const fraction = text.match(/(\d+)\s*\/\s*(\d+)\s*(oz|ounce)/i);
  if (fraction) {
    const num = Number.parseFloat(fraction[1]!);
    const den = Number.parseFloat(fraction[2]!);
    if (den !== 0) return round2((num / den) * GRAMS_PER_OUNCE);
  }

  const match = text.match(/(\d+(?:\.\d+)?)\s*(g\b|gram|grams|oz\b|ounce|ounces|lb\b|lbs\b|pound|pounds|kg\b|kilo)/i);
  if (!match) return null;

  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("kg") || unit.startsWith("kilo")) return round2(value * 1000);
  if (unit.startsWith("lb") || unit.startsWith("pound")) return round2(value * GRAMS_PER_POUND);
  if (unit.startsWith("oz") || unit.startsWith("ounce")) return round2(value * GRAMS_PER_OUNCE);
  return round2(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map cannabinoid + form onto a marketplace category slug. */
export function categoryFor(cannabinoid: Cannabinoid, form: ProductForm): string | null {
  switch (form) {
    case "pre_roll": return "pre-rolls";
    case "gummy": return "gummies";
    case "vape": return "vapes";
    case "drink": return "thc-drinks";
    case "tincture": return cannabinoid === "cbn" ? "cbn-sleep" : "tinctures";
    case "topical": return "wellness";
    case "accessory": return "accessories";
    case "flower":
      if (cannabinoid === "thca") return "thca-flower";
      if (cannabinoid === "cbd") return "cbd-flower";
      if (cannabinoid === "cbg") return "cbg-flower";
      return "hemp-flower";
    case "concentrate":
    case "unknown":
    default:
      // Don't guess a category from a cannabinoid alone — an unclassified
      // product is more useful than a confidently wrong one.
      return null;
  }
}

export interface NormalizeInput {
  title: string;
  description?: string;
  rawCategory?: string;
  variantName?: string;
  priceCents?: number;
}

export function normalizeProduct(input: NormalizeInput): NormalizedProduct {
  // Weight usually lives in the variant name ("3.5g"), so read it first and
  // fall back to the title. Description is excluded on purpose: it is full of
  // other products' weights and poisons the parse.
  const classifyText = [input.title, input.rawCategory ?? "", input.description ?? ""].join(" ");
  const weightText = [input.variantName ?? "", input.title].join(" ");

  const cannabinoid = detectCannabinoid(classifyText);
  const form = detectForm(classifyText);
  const weightGrams = parseWeightGrams(weightText);

  const pricePerGram =
    weightGrams && weightGrams > 0 && input.priceCents !== undefined
      ? round2(input.priceCents / 100 / weightGrams)
      : null;

  return {
    cannabinoid,
    form,
    categorySlug: categoryFor(cannabinoid, form),
    weightGrams,
    pricePerGram,
  };
}
