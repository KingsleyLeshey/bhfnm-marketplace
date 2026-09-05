// Server wrapper for the interactive availability/buy panel.
//
// Keep the rich Product object on the server. Only the fields required for
// destination eligibility and purchasing are serialized into the RSC/client
// payload, preventing SKUs, exact stock counts, search facts and compliance
// internals from hitchhiking into browser-readable Next.js data.

import type { Product } from "@/lib/types";
import { AvailabilityClient } from "./AvailabilityClient";

export function AvailabilitySection({
  product,
  vendorName,
  vendorSlug,
  live,
}: {
  product: Product;
  vendorName: string;
  vendorSlug: string;
  live: boolean;
}) {
  return (
    <AvailabilityClient
      eligibility={{
        restrictedJurisdictions: product.restrictedJurisdictions,
        cannabinoidType: product.cannabinoidType,
        shippingOrigin: product.shippingOrigin,
        ageRestricted: product.ageRestricted,
      }}
      variants={product.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        priceCents: variant.priceCents,
        inStock: variant.stock > 0,
        wholesaleOnly: variant.wholesaleOnly,
      }))}
      vendorName={vendorName}
      vendorSlug={vendorSlug}
      live={live}
    />
  );
}
