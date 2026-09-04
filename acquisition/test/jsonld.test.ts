import { describe, expect, it } from "vitest";
import { harvestJsonLd, parsePriceCents } from "../src/extract/jsonld";

const shopifyProduct = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Sunset Gelato THCA Flower",
 "sku":"SG-35","brand":{"@name":"x","name":"Blue Ridge"},"category":"Flower",
 "image":["https://cdn.example.com/a.jpg"],
 "offers":{"@type":"Offer","price":"44.99","priceCurrency":"USD",
           "availability":"https://schema.org/InStock","url":"https://x.com/p/1"}}
</script>
</head></html>`;

describe("harvestJsonLd", () => {
  it("extracts a Shopify-style product", () => {
    const { products } = harvestJsonLd(shopifyProduct);
    expect(products).toHaveLength(1);
    const p = products[0]!;
    expect(p.name).toBe("Sunset Gelato THCA Flower");
    expect(p.priceCents).toBe(4499);
    expect(p.currency).toBe("USD");
    expect(p.inStock).toBe(true);
    expect(p.brand).toBe("Blue Ridge");
    expect(p.image).toBe("https://cdn.example.com/a.jpg");
  });

  it("walks @graph containers", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"Organization","name":"Acme Hemp","email":"info@acme.com"},
                 {"@type":"Product","name":"CBG Flower","offers":{"price":30}}]}
    </script>`;
    const { products, organization } = harvestJsonLd(html);
    expect(organization?.name).toBe("Acme Hemp");
    expect(organization?.email).toBe("info@acme.com");
    expect(products[0]!.name).toBe("CBG Flower");
    expect(products[0]!.priceCents).toBe(3000);
  });

  it("reads organization address and social profiles", () => {
    const html = `<script type="application/ld+json">
      {"@type":"LocalBusiness","name":"Mountain Hemp","telephone":"+1-555-0100",
       "address":{"@type":"PostalAddress","addressLocality":"Asheville",
                  "addressRegion":"NC","addressCountry":"US"},
       "sameAs":["https://instagram.com/mountainhemp"]}
    </script>`;
    const { organization } = harvestJsonLd(html);
    expect(organization?.addressRegion).toBe("NC");
    expect(organization?.addressLocality).toBe("Asheville");
    expect(organization?.sameAs).toEqual(["https://instagram.com/mountainhemp"]);
  });

  it("unwraps AggregateOffer to the first real offer", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"Bulk CBD","offers":{"@type":"AggregateOffer",
        "offers":[{"@type":"Offer","price":"199.00","priceCurrency":"USD"}]}}
    </script>`;
    expect(harvestJsonLd(html).products[0]!.priceCents).toBe(19900);
  });

  it("handles multiple @type values", () => {
    const html = `<script type="application/ld+json">
      {"@type":["Product","Thing"],"name":"Multi"}</script>`;
    expect(harvestJsonLd(html).products).toHaveLength(1);
  });

  it("counts malformed blocks instead of throwing", () => {
    const html = `<script type="application/ld+json">{ not json }</script>
                  <script type="application/ld+json">{"@type":"Product","name":"OK"}</script>`;
    const h = harvestJsonLd(html);
    expect(h.malformedBlocks).toBe(1);
    expect(h.products).toHaveLength(1);
  });

  it("returns empty for a page with no JSON-LD", () => {
    const h = harvestJsonLd("<html><body><h1>Nothing here</h1></body></html>");
    expect(h.products).toEqual([]);
    expect(h.organization).toBeNull();
  });

  it("skips products with no name", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","sku":"X"}</script>`;
    expect(harvestJsonLd(html).products).toHaveLength(0);
  });
});

describe("parsePriceCents", () => {
  it("handles strings, numbers and currency symbols", () => {
    expect(parsePriceCents("44.99")).toBe(4499);
    expect(parsePriceCents(30)).toBe(3000);
    expect(parsePriceCents("$12.50")).toBe(1250);
  });

  it("rejects junk", () => {
    expect(parsePriceCents("")).toBeUndefined();
    expect(parsePriceCents(null)).toBeUndefined();
    expect(parsePriceCents("free")).toBeUndefined();
  });
});
