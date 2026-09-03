# Go-Live Runbook — staging (vercel.app) → production (buyhempflowernearme.com/marketplace)

Current state: app deployed and working at
`https://bhfnm-marketplace.vercel.app/marketplace`.
Target: same app served at `https://buyhempflowernearme.com/marketplace`,
with WordPress untouched on every other path.

The domain's DNS zone is on Cloudflare and already proxies the WordPress
origin (Hostinger). **We do not change DNS and we do not attach the domain to
Vercel.** A Cloudflare Worker routes only `/marketplace*` to Vercel.
Rollback at any moment = remove the Worker route.

---

## Step 0 — Secrets hygiene (do this before anything public)

**Status (verified 2026-09-03): this repository is clean.** `.env.example` holds
only empty placeholders in every commit it has ever appeared in, and a scan of
all blobs across all refs for JWT-shaped strings, `sk_live`/`sk_test`, Resend
keys and private-key headers found nothing. An earlier revision of this runbook
warned that real Supabase keys were tracked in git — that described a local
working copy that was never pushed. **No key rotation is required on account of
this repo's history.**

Keep it that way:

1. Copy the example to `.env.local` (gitignored) for local dev:
   ```powershell
   Copy-Item .env.example .env.local
   ```
2. Put real values only in `.env.local` — never in `.env.example`.
3. The service-role key must exist ONLY in: `.env.local` (your machine) and
   Vercel env vars (server-side). Never in client-side code or tracked files.
4. If a real key ever does land in a commit, rotate it in
   Supabase Dashboard → Project Settings → API before doing anything else.

## Step 1 — Supabase: apply schema

If not already done (the deployed app reporting `"database":"seed-fallback"`
means the env vars aren't set in Vercel yet; once set, the schema must exist):

```bash
npm i -g supabase
supabase login
supabase link --project-ref swsgsukibzfdqxvintre
supabase db push                 # applies ALL of supabase/migrations/0001 → 0005
psql "$DATABASE_URL" -f supabase/seed.sql   # baseline categories + jurisdiction rules
```
(Or paste each migration into the Supabase SQL Editor **in order**:
`0001_init.sql`, `0002_rls_policies.sql`, `0003_auth_and_settlement.sql`,
`0004_search.sql`, `0005_rls_helper_recursion_fix.sql`, then `seed.sql`.)

**All five are required. Two of them are easy to miss and were omitted from
earlier versions of this runbook:**

| Migration | Skipping it causes |
|---|---|
| `0003_auth_and_settlement.sql` | No profiles trigger, no settlement ledger RPC, no checkout idempotency key. The app self-heals profiles, but settlement and dedupe break. |
| `0004_search.sql` | `search_products` RPC missing → search silently falls back to an unranked ILIKE scan. Degrades quietly; easy to miss. |
| `0005_rls_helper_recursion_fix.sql` | **Hard failure.** RLS helper recursion raises Postgres `54001 stack depth limit exceeded` and **every anonymous catalog query 404s**. Not optional, and it does not degrade gracefully. |

After applying, sanity-check 0005 from an anonymous (anon-key) client: a live
product page must return 200, not 404.

Create storage buckets: `product-images`, `brand-assets` (public);
`coas`, `vendor-documents`, `dispute-evidence`, `shipping-evidence` (private).

## Step 2 — Vercel: production env vars

Vercel Dashboard → bhfnm-marketplace project → Settings → Environment Variables
(scope: Production):

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://swsgsukibzfdqxvintre.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (anon key) |
| `SUPABASE_SERVICE_ROLE_KEY` | (service role key — server-side only) |
| `NEXT_PUBLIC_SITE_URL` | `https://buyhempflowernearme.com` ← **critical**: canonicals, OG URLs and sitemap entries derive from this; without it they'd point at vercel.app and split SEO |
| `BTCPAY_*` | leave unset until BTCPay is stood up — checkout stays in its honest "payments not yet enabled" state |

Then **Redeploy** (Deployments → ⋯ → Redeploy) so the env takes effect.
Verify: `https://bhfnm-marketplace.vercel.app/marketplace/api/health` should
report `"database":"configured"` (not `"seed-fallback"`). It also reports
`"payments"` as `"configured"` or `"disabled"` — `"disabled"` is correct until
BTCPay is stood up.

## Step 3 — Cloudflare Worker: route /marketplace* to Vercel

Everything needed is in `cloudflare/`:

```bash
cd cloudflare
npm i -g wrangler
wrangler login                          # authorizes against the Cloudflare account holding the zone
wrangler secret put VERCEL_ORIGIN       # enter: bhfnm-marketplace.vercel.app
wrangler secret put PROXY_SECRET        # enter: any long random string
wrangler deploy                         # deploys worker + route buyhempflowernearme.com/marketplace*
```

The route pattern is already declared in `wrangler.toml`. If `wrangler deploy`
can't bind the route (permissions), add it manually: Cloudflare Dashboard →
Workers & Pages → bhfnm-marketplace-router → Settings → Domains & Routes →
Add route: `buyhempflowernearme.com/marketplace*`, zone `buyhempflowernearme.com`.

Dashboard-only alternative (no CLI): Workers & Pages → Create Worker →
paste `marketplace-router.js` → Settings → Variables: add `VERCEL_ORIGIN` and
`PROXY_SECRET` as secrets → add the route as above.

## Step 4 — Smoke test production

```powershell
# each must return 200 and marketplace content (not WordPress):
https://buyhempflowernearme.com/marketplace
https://buyhempflowernearme.com/marketplace/categories/hemp-flower
https://buyhempflowernearme.com/marketplace/product/<any-live-slug>
https://buyhempflowernearme.com/marketplace/sitemap.xml
https://buyhempflowernearme.com/marketplace/api/health
# and WordPress must be untouched:
https://buyhempflowernearme.com/            # WP homepage
https://buyhempflowernearme.com/hemp-laws-by-state/
```
Also check a `_next` asset loads (view page source → any `/marketplace/_next/...`
URL → open it → 200).

## Step 5 — SEO wiring (after smoke test passes)

1. Google Search Console (existing property for the domain) → Sitemaps →
   submit `https://buyhempflowernearme.com/marketplace/sitemap.xml`.
2. WordPress: append to robots.txt (many SEO plugins expose an editor):
   `Sitemap: https://buyhempflowernearme.com/marketplace/sitemap.xml`
3. WordPress nav: add a "Marketplace" menu item linking to `/marketplace`.

## Step 6 — Rollback (if anything looks wrong)

Cloudflare Dashboard → Workers & Pages → bhfnm-marketplace-router →
Settings → Domains & Routes → delete the route. The path instantly falls back
to the WordPress origin's 404. WordPress is never at risk.

---

## Post-launch (separate work items, in order)

1. Stand up BTCPay Server (VPS + Docker), set `BTCPAY_*` in Vercel, register the
   webhook at `https://buyhempflowernearme.com/marketplace/api/webhooks/btcpay`
   → enables real checkout (docs/06-deployment.md §BTCPay).
2. Create the first admin: set `role='admin'` on your profile row in Supabase.
3. Meilisearch host + env vars → full faceted search.
4. Shipping carrier account (EasyPost) → label generation.
