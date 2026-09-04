import { describe, expect, it } from "vitest";
import {
  categoryFor,
  detectCannabinoid,
  detectForm,
  normalizeProduct,
  parseWeightGrams,
} from "../src/extract/normalize";

describe("detectCannabinoid", () => {
  it("collapses the THCA spelling variants the brief called out", () => {
    expect(detectCannabinoid("THCA Flower")).toBe("thca");
    expect(detectCannabinoid("THCa Hemp Flower")).toBe("thca");
    expect(detectCannabinoid("High THCA Flower")).toBe("thca");
    expect(detectCannabinoid("THC-A Premium Buds")).toBe("thca");
  });

  it("does not misread THCA as delta-9", () => {
    expect(detectCannabinoid("THCA Flower")).not.toBe("delta9_hemp");
  });

  it("distinguishes the delta variants", () => {
    expect(detectCannabinoid("Delta 8 Gummies")).toBe("delta8");
    expect(detectCannabinoid("Delta-9 Seltzer")).toBe("delta9_hemp");
    expect(detectCannabinoid("D8 Cart")).toBe("delta8");
  });

  it("separates CBG and CBN from CBD", () => {
    expect(detectCannabinoid("CBG Flower")).toBe("cbg");
    expect(detectCannabinoid("CBN Sleep Tincture")).toBe("cbn");
    expect(detectCannabinoid("Full Spectrum CBD Oil")).toBe("cbd");
  });

  it("reports genuine blends as mixed", () => {
    expect(detectCannabinoid("CBD + CBN Sleep Gummies")).toBe("mixed");
  });

  it("returns none when nothing matches", () => {
    expect(detectCannabinoid("Glass Grinder")).toBe("none");
  });
});

describe("detectForm", () => {
  it("classifies the common forms", () => {
    expect(detectForm("Pre-Roll 5 Pack")).toBe("pre_roll");
    expect(detectForm("Sour Gummies")).toBe("gummy");
    expect(detectForm("Live Resin Cartridge")).toBe("vape");
    expect(detectForm("Hemp Seltzer")).toBe("drink");
    expect(detectForm("Sleep Tincture")).toBe("tincture");
    expect(detectForm("Indoor Flower")).toBe("flower");
  });

  it("prefers pre-roll over flower when both words appear", () => {
    expect(detectForm("THCA Flower Pre-Rolls")).toBe("pre_roll");
  });

  it("returns unknown for unclassifiable text", () => {
    expect(detectForm("Mystery Box")).toBe("unknown");
  });
});

describe("parseWeightGrams", () => {
  it("parses grams", () => {
    expect(parseWeightGrams("3.5g")).toBe(3.5);
    expect(parseWeightGrams("28 grams")).toBe(28);
  });

  it("converts ounces and pounds", () => {
    expect(parseWeightGrams("1 oz")).toBeCloseTo(28.35, 1);
    expect(parseWeightGrams("1lb")).toBeCloseTo(453.59, 1);
  });

  it("handles the fractional-ounce shorthand", () => {
    expect(parseWeightGrams("1/8 oz")).toBeCloseTo(3.54, 1);
  });

  it("returns null when there is no weight", () => {
    expect(parseWeightGrams("Default Title")).toBeNull();
    expect(parseWeightGrams("")).toBeNull();
  });
});

describe("categoryFor", () => {
  it("routes flower by cannabinoid", () => {
    expect(categoryFor("thca", "flower")).toBe("thca-flower");
    expect(categoryFor("cbd", "flower")).toBe("cbd-flower");
    expect(categoryFor("cbg", "flower")).toBe("cbg-flower");
    expect(categoryFor("none", "flower")).toBe("hemp-flower");
  });

  it("routes CBN tinctures to the sleep category", () => {
    expect(categoryFor("cbn", "tincture")).toBe("cbn-sleep");
    expect(categoryFor("cbd", "tincture")).toBe("tinctures");
  });

  it("refuses to guess for unknown forms", () => {
    expect(categoryFor("cbd", "unknown")).toBeNull();
  });
});

describe("normalizeProduct", () => {
  it("normalizes a full THCA flower listing", () => {
    const r = normalizeProduct({
      title: "Sunset Gelato THCA Flower",
      variantName: "3.5g",
      rawCategory: "Flower",
      priceCents: 4499,
    });
    expect(r.cannabinoid).toBe("thca");
    expect(r.form).toBe("flower");
    expect(r.categorySlug).toBe("thca-flower");
    expect(r.weightGrams).toBe(3.5);
    expect(r.pricePerGram).toBeCloseTo(12.85, 1);
  });

  it("reads weight from the variant, not the description", () => {
    const r = normalizeProduct({
      title: "CBD Flower",
      variantName: "7g",
      description: "Also available in 28g and 1oz sizes",
    });
    expect(r.weightGrams).toBe(7);
  });

  it("leaves price per gram null without a weight", () => {
    const r = normalizeProduct({ title: "CBD Gummies", priceCents: 2999 });
    expect(r.pricePerGram).toBeNull();
    expect(r.categorySlug).toBe("gummies");
  });
});
