import { NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/data";
import { getBtcPayConfig } from "@/lib/payments/btcpay";

export function GET() {
  // Public catalog reads are intentionally server-mediated after the catalog
  // hardening migration. Treat a deployment without the service role as
  // incomplete so rollout checks fail before SEO-visible catalog pages can go
  // empty after raw anon SELECT is revoked.
  const secureCatalogConfigured =
    supabaseConfigured && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  return NextResponse.json({
    ok: true,
    services: {
      database: secureCatalogConfigured ? "configured" : "incomplete",
      payments: getBtcPayConfig() ? "configured" : "disabled",
    },
  });
}
