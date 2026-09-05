import "server-only";

// Supabase client factories for server-side code.
//
// Public storefront reads intentionally run through the server with the service
// role. Raw anonymous/authenticated SELECT access to catalog tables is revoked
// by migration 0006, so crawlers get the curated HTML/JSON-LD surface rather
// than a machine-perfect PostgREST database export.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function serviceClient(): SupabaseClient | null {
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

/**
 * Backwards-compatible name used by the public data layer.
 *
 * IMPORTANT: this is a SERVER-ONLY curated catalog reader, not a browser anon
 * client. Callers must keep explicit public-state filters (`live`, `active`,
 * `published`, verified compliance) because the service role bypasses RLS.
 */
export function supabaseAnon(): SupabaseClient | null {
  return serviceClient();
}

/** Privileged server client for checkout, webhooks, admin and vendor actions. */
export function supabaseService(): SupabaseClient | null {
  return serviceClient();
}
