import { describe, expect, it } from "vitest";
import {
  MIN_EXTRACTION_CONFIDENCE,
  WEIGHTS,
  WEIGHTS_VERSION,
  breadthScore,
  evaluateGates,
  scoreProspect,
  seoOpportunity,
} from "../src/score/prospect";

const strong = {
  supplyGapFit: 1,
  productCount: 50,
  catalogClarity: 1,
  seoOpportunity: 1,
  brandStrength: 1,
  wholesaleAvailable: true,
  privateLabelAvailable: true,
  geographicValue: 1,
  marketplaceAbsence: 1,
  complianceReadiness: 1,
};

const weak = {
  supplyGapFit: 0,
  productCount: 0,
  catalogClarity: 0,
  seoOpportunity: 0,
  brandStrength: 0,
  wholesaleAvailable: false,
  privateLabelAvailable: false,
  geographicValue: 0,
  marketplaceAbsence: 0,
  complianceReadiness: 0,
};

const openGates = {
  robotsAllowed: true,
  hasRoleContact: true,
  isSuppressed: false,
  alreadyVendor: false,
  categoryOnboardable: true,
  extractionConfidence: 0.9,
};

describe("weights", () => {
  it("sums to 100 as documented", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("scoreProspect", () => {
  it("scores an ideal prospect at the top of the range", () => {
    expect(scoreProspect(strong).score).toBe(100);
  });

  it("floors a null prospect near zero", () => {
    // wholesalePotential contributes 0.15 even when absent, so not exactly 0.
    expect(scoreProspect(weak).score).toBeLessThan(2);
  });

  it("records the weights version so old scores stay explainable", () => {
    expect(scoreProspect(strong).weightsVersion).toBe(WEIGHTS_VERSION);
  });

  it("clamps out-of-range inputs instead of trusting them", () => {
    const r = scoreProspect({ ...weak, supplyGapFit: 5, catalogClarity: -3 });
    expect(r.components.marketFit).toBe(1);
    expect(r.components.productQuality).toBe(0);
  });

  it("ranks a gap-filling supplier above a broader irrelevant one", () => {
    const relevant = scoreProspect({ ...weak, supplyGapFit: 1, productCount: 10 });
    const irrelevant = scoreProspect({ ...weak, supplyGapFit: 0, productCount: 200 });
    expect(relevant.score).toBeGreaterThan(irrelevant.score);
  });
});

describe("breadthScore", () => {
  it("has diminishing returns", () => {
    const gain1 = breadthScore(25) - breadthScore(5);
    const gain2 = breadthScore(400) - breadthScore(200);
    expect(gain1).toBeGreaterThan(gain2);
  });

  it("is zero for an empty catalog", () => {
    expect(breadthScore(0)).toBe(0);
  });
});

describe("evaluateGates", () => {
  it("passes a clean prospect", () => {
    expect(evaluateGates(openGates)).toEqual({ contactable: true, failures: [] });
  });

  it("blocks on robots even with everything else perfect", () => {
    const r = evaluateGates({ ...openGates, robotsAllowed: false });
    expect(r.contactable).toBe(false);
    expect(r.failures).toContain("robots_disallowed");
  });

  it("requires a role contact", () => {
    expect(evaluateGates({ ...openGates, hasRoleContact: false }).contactable).toBe(false);
  });

  it("blocks suppressed companies and existing vendors", () => {
    expect(evaluateGates({ ...openGates, isSuppressed: true }).contactable).toBe(false);
    expect(evaluateGates({ ...openGates, alreadyVendor: true }).contactable).toBe(false);
  });

  it("blocks categories we cannot legally onboard", () => {
    const r = evaluateGates({ ...openGates, categoryOnboardable: false });
    expect(r.failures).toContain("category_not_onboardable");
  });

  it("blocks on low extraction confidence", () => {
    const r = evaluateGates({ ...openGates, extractionConfidence: MIN_EXTRACTION_CONFIDENCE - 0.01 });
    expect(r.failures).toContain("low_confidence");
  });

  it("reports every failure, not just the first", () => {
    const r = evaluateGates({
      robotsAllowed: false, hasRoleContact: false, isSuppressed: true,
      alreadyVendor: true, categoryOnboardable: false, extractionConfidence: 0,
    });
    expect(r.failures).toHaveLength(6);
  });

  it("gates are independent of score — a perfect score cannot open them", () => {
    expect(scoreProspect(strong).score).toBe(100);
    expect(evaluateGates({ ...openGates, isSuppressed: true }).contactable).toBe(false);
  });
});

describe("seoOpportunity", () => {
  it("rewards structure and depth", () => {
    const rich = seoOpportunity({ hasSitemap: true, indexablePages: 200, hasStructuredData: true, hasBlogContent: true });
    const bare = seoOpportunity({ hasSitemap: false, indexablePages: 3, hasStructuredData: false, hasBlogContent: false });
    expect(rich).toBeGreaterThan(bare);
    expect(rich).toBeLessThanOrEqual(1);
    expect(bare).toBeGreaterThanOrEqual(0);
  });
});
