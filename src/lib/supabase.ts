import "server-only";

// Supabase client factories for server-side code.
//
// Public storefront reads intentionally run through the server. In production
// they use the service role so raw anonymous/authenticated catalog SELECTs can
// be revoked without hurting SEO-visible HTML, JSON-LD or sitemaps.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function serverCatalogClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Backwards-compatible name used by the public data layer.
 *
 * IMPORTANT: this is SERVER-ONLY. With SUPABASE_SERVICE_ROLE_KEY configured it
 * bypasses RLS, so callers must keep explicit public-state filters (`live`,
 * `active`, `published`, verified compliance). The anon-key fallback exists so
 * previews fail closed/empty rather than crash if the service key is absent.
 */
export function supabaseAnon(): SupabaseClient | null {
  return serverCatalogClient();
}

/** Privileged server client for checkout, webhooks, admin and vendor actions. */
export function supabaseService(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
