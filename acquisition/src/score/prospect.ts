// Prospect scoring.
//
// Structure is lifted deliberately from the marketplace's listing health score:
// named components normalized to 0..1, a separate versioned weights table, and
// — the part that matters most — HARD GATES kept out of the weighted score, so
// a strong prospect can never score its way past a rule.
//
// Weights are starting assumptions. They are versioned so that when outcome
// data arrives (which prospects actually converted, and which converted sellers
// produced GMV) the weights can be refitted without invalidating history:
// every stored score records the weights version that produced it.

export const WEIGHTS_VERSION = "v1-2026-09";

export interface ScoreInputs {
  /** Does this company supply a category the marketplace is short of? 0..1 */
  supplyGapFit: number;
  /** Distinct normalized product types found on their site. */
  productCount: number;
  /** Share of extracted products that classified cleanly. 0..1 */
  catalogClarity: number;
  /** Organic visibility proxy — see seoOpportunity(). 0..1 */
  seoOpportunity: number;
  /** Brand signals: own domain age, social presence, named brand. 0..1 */
  brandStrength: number;
  wholesaleAvailable: boolean;
  privateLabelAvailable: boolean;
  /** Do they ship to states the marketplace currently under-serves? 0..1 */
  geographicValue: number;
  /** Are they already on a competing marketplace? Lower = better target. 0..1 */
  marketplaceAbsence: number;
  /** Structured compliance signals present on site (COAs published, lab named). 0..1 */
  complianceReadiness: number;
}

export interface GateInputs {
  robotsAllowed: boolean;
  hasRoleContact: boolean;
  isSuppressed: boolean;
  alreadyVendor: boolean;
  /** False when their categories are ones we cannot legally onboard. */
  categoryOnboardable: boolean;
  /** Extraction confidence must clear a floor before we act on the score. */
  extractionConfidence: number;
}

export const MIN_EXTRACTION_CONFIDENCE = 0.6;

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/**
 * Diminishing returns on catalog size: going 5 → 25 products says a lot about
 * a supplier, 200 → 400 says almost nothing.
 */
export function breadthScore(productCount: number): number {
  if (productCount <= 0) return 0;
  return clamp(Math.log10(productCount + 1) / Math.log10(51));
}

export const WEIGHTS: Record<string, number> = {
  marketFit: 20,
  productBreadth: 15,
  productQuality: 15,
  seoOpportunity: 15,
  brandStrength: 10,
  wholesalePotential: 10,
  geographicValue: 5,
  conversionProbability: 5,
  complianceReadiness: 5,
};

export interface ScoreResult {
  score: number;
  components: Record<string, number>;
  weightsVersion: string;
}

export function scoreProspect(i: ScoreInputs): ScoreResult {
  const components: Record<string, number> = {
    marketFit: clamp(i.supplyGapFit),
    productBreadth: breadthScore(i.productCount),
    productQuality: clamp(i.catalogClarity),
    seoOpportunity: clamp(i.seoOpportunity),
    brandStrength: clamp(i.brandStrength),
    wholesalePotential: i.wholesaleAvailable ? (i.privateLabelAvailable ? 1 : 0.75) : 0.15,
    geographicValue: clamp(i.geographicValue),
    // A company not yet on any marketplace is both easier to win and worth
    // more once won — no split loyalty, and we become their channel.
    conversionProbability: clamp(i.marketplaceAbsence),
    complianceReadiness: clamp(i.complianceReadiness),
  };

  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += (components[key] ?? 0) * weight;
    weightSum += weight;
  }

  return {
    score: Math.round((total / weightSum) * 1000) / 10,
    components,
    weightsVersion: WEIGHTS_VERSION,
  };
}

export interface GateResult {
  contactable: boolean;
  failures: string[];
}

/**
 * Hard gates. Every one of these is a rule, not a preference — none of them
 * can be outweighed by a high score elsewhere. A prospect that fails any gate
 * is never contacted, however attractive it looks.
 */
export function evaluateGates(g: GateInputs): GateResult {
  const failures: string[] = [];
  if (!g.robotsAllowed) failures.push("robots_disallowed");
  if (!g.hasRoleContact) failures.push("no_role_contact");
  if (g.isSuppressed) failures.push("suppressed");
  if (g.alreadyVendor) failures.push("already_vendor");
  if (!g.categoryOnboardable) failures.push("category_not_onboardable");
  if (g.extractionConfidence < MIN_EXTRACTION_CONFIDENCE) failures.push("low_confidence");
  return { contactable: failures.length === 0, failures };
}

/**
 * SEO opportunity proxy from signals available at crawl time. A site with
 * real content and structure but a thin catalog is the ideal target: their
 * traffic transfers, and our category pages give their products a second home.
 */
export function seoOpportunity(signals: {
  hasSitemap: boolean;
  indexablePages: number;
  hasStructuredData: boolean;
  hasBlogContent: boolean;
}): number {
  const depth = clamp(Math.log10(signals.indexablePages + 1) / Math.log10(201));
  let score = depth * 0.5;
  if (signals.hasSitemap) score += 0.15;
  if (signals.hasStructuredData) score += 0.2;
  if (signals.hasBlogContent) score += 0.15;
  return clamp(score);
}
