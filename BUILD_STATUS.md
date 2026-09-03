# BUILD_STATUS — BHFNM Marketplace

Last updated: 2026-09-03 (status review at commit `313a3cd`)
Previous update: 2026-07-04 (beta milestone) — 14 commits have landed since.

## Snapshot

| | |
|---|---|
| Head commit | `313a3cd` (2026-07-08) — branch and `main` are level, 0 commits ahead |
| Last code change | 2026-07-08 — **~8 weeks of no commits** |
| Size | 105 TS/TSX files, ~11k LOC, 5 SQL migrations |
| `pnpm typecheck` | **passes** (verified 2026-09-03 on a clean install) |
| `pnpm build` | **passes** — all routes compile; SSG prerenders categories, products, stores, legal |
| Automated tests | **none exist** — no test runner, no test files (see *Verification gap*) |
| Deployment | Vercel app behind a Cloudflare Worker on `/marketplace*`; production cutover not confirmed in-repo |

## What actually blocks go-live

These are ordered by what stops a launch, not by effort.

### 1. The runbook will deploy a broken database (documentation defect)

`docs/08-go-live-runbook.md` Step 1 tells the operator to apply **0001 + 0002 only**.
The 2026-07-04 status note added **0003**. Migrations **0004 and 0005 are named
nowhere in any doc** — not in the runbook, README, or this file before today.

That matters because:

- **`0005` is not optional and does not degrade.** It puts `SECURITY DEFINER` on
  the `is_admin()` / `my_vendor_id()` RLS helpers. Without it the policy cycle
  (`products` policy → helper → `SELECT profiles` → that table's policy → helper → …)
  raises Postgres `54001 stack depth limit exceeded`, and **every anonymous
  catalog query 404s**. This was a live production symptom on 2026-07-08; a fresh
  deploy following the current runbook reproduces it exactly.
- **`0004` degrades quietly.** `searchProducts()` calls the `search_products` RPC
  and falls back to an unranked `ILIKE` scan when it is missing
  (`src/lib/data.ts:216-224`). Search "works", just badly — so nobody notices the
  migration was skipped.

Fixed in this commit: the runbook now lists 0001–0005 and flags 0005 as required.

### 2. BTCPay is not stood up — so Phase 2's exit criterion is unproven

Checkout, invoice creation, the HMAC webhook, order state mapping and the atomic
settlement ledger are all written and typecheck clean. **No real BTC order has
settled end-to-end.** Until `BTCPAY_*` is set and a regtest order is paid, the
whole commerce path is code-complete-but-unverified, which is not the same as done.
The app is honest about this: without the env vars checkout stays disabled rather
than faking a success.

### 3. Email is wired but silent

`lib/email.ts` no-ops to structured console logs until `RESEND_API_KEY` /
`EMAIL_FROM` are set. Application decisions, product decisions and payment
receipts all fire events that currently go nowhere. Intentional, but it means no
vendor or buyer is notified of anything in the current deployment.

## Verification gap

The 2026-07-04 entry claimed "guard/webhook/truthfulness tests pass." **There are
no test files in the repository and no test runner in `package.json`.** Whatever
was run on 2026-07-04 was throwaway validation that was never committed, so none
of it protects against regression today.

What is actually verified as of 2026-09-03 is what the toolchain can prove:
typecheck and a production build. Every behavioural claim below — role guards,
webhook idempotency, the truthfulness guard — rests on code reading, not on a
test anyone can re-run. Standing up a real test suite around the guard, the
webhook and `dataMode()` is the highest-value non-feature work available.

## Phase status against docs/07-roadmap-and-ui.md

| Phase | State | Notes |
|---|---|---|
| 1 — Foundation | **Done** | Catalog, SSR/SEO, vendor application, admin queues, age gate, sitemaps |
| 2 — Commerce | **Code complete, unproven** | Cart, checkout, BTCPay invoice, webhook, ledger, commission all written; exit criterion (a settled BTC order) not met |
| 3 — Fulfillment & trust | **Partial** | Messaging + moderation shipped. Shipping, disputes intake, verified reviews, payout execution missing |
| 4 — Growth | **Partial** | Shopify/Woo CSV importer shipped; wholesale buyer profile shipped. Vendor-side wholesale approval, sponsored placements, analytics, referrals missing |
| 5 — Expansion | Not started | |

## Shipped since the last status update (2026-07-04 → 07-08)

- **Postgres-native search** (`4457f3c`, `0004`): weighted tsvector + trigram
  ranking with verified-COA and in-stock boosts — no external engine, no cost.
  Typeahead suggest endpoint.
- **RLS recursion fix** (`313a3cd`, `0005`): see blocker 1.
- **Marketplace inbox** (`7c0b35e`): buyer and vendor threads with real sends,
  every message through the off-platform-contact detectors; flagged messages
  persist flagged and immutable for admin review. This closes the "messaging
  send/reply UI" item previously listed as intentionally unavailable.
- **Superadmin store controls** (`7c0b35e`): suspend/reinstate — suspension pulls
  the live catalog to `suspended` and reinstate restores it — plus commission
  override and reserve-tier editing. All audited.
- **Catalog import** (`a944167`): Shopify + WooCommerce CSV with a category
  mapping wizard. Imports land as **drafts only** and preserve the source
  taxonomy as search facts; nothing goes live without review.
- **Guided listing studio** (`429a158`): vendor draft editing with a quality
  score and SERP preview.
- **Email onboarding** (`f4e3595`): forgot/reset password pages, branded HTML
  transactional templates.
- **Sign-in cookie race fixed** (`429a158`): the double-click-to-sign-in bug.
- **WordPress theme 0.5.0 + SEO plugin** (`c7d5697`, `87b613d`, `e923d09`):
  marketplace shell, light-default theming, cross-linking; zips in `dist/`.
- **Product image uploads** (`9c89d07`): real Supabase Storage pipeline for
  `product-images`.

## Still intentionally unavailable (honest UI notes, not dead buttons)

- **Shipping labels and tracking.** `lib/shipping/provider.ts` defines the
  interface, approved carrier matrix and the acceptance-scan rule — **no adapter
  implements it**. Needs an EasyPost account.
- **Dispute intake.** Disputes render read-only; there is no create endpoint.
  Genuinely blocked: intake opens 48h after *delivery*, which needs shipping first.
- **Verified reviews.** No review submission API; reviews render from `published`
  rows only. Blocked on the same fulfillment signal.
- **Payout execution.** Real accruals display; the actual BTC send is manual.
- **Wholesale approve/deny.** Buyers can request; vendors cannot yet action it
  (`vendor-dashboard/wholesale` says so on the page).
- **COA file upload.** Structured COA data flows and gates badges; the file
  itself has no storage pipeline yet.

## Security posture (reviewed 2026-09-03)

- **No secrets in the repo or in git history.** Scanned every blob across all
  refs for JWT-shaped strings, `sk_live`/`sk_test`, Resend keys and private-key
  headers: clean. `.env.example` has only empty placeholders in every commit it
  has ever appeared in. **The runbook's Step 0 warning that ".env.example
  currently holds the real Supabase keys and is tracked by git" is false for this
  repository** — it describes a local working copy that was never pushed. The key
  rotation it demands is not required on the strength of this repo's history.
  (Corrected in the runbook in this commit.)
- Identity and role are derived server-side from the cookie session
  (`src/lib/auth.ts`); no client payload is trusted for id or role.
- Defence in depth holds: middleware session gate → server-side role guard →
  RLS. The service-role client is server-only.
- The BTCPay webhook verifies HMAC with a timing-safe compare and dedupes on
  event id.

## Operator setup still required (one-time)

1. **Apply migrations 0001 → 0005 in order.** 0005 is required, not optional —
   without it the public catalog 404s.
2. Create storage buckets: `product-images`, `brand-assets` (public);
   `coas`, `vendor-documents`, `dispute-evidence`, `shipping-evidence` (private).
3. Supabase Auth: disable email confirmation (beta); Site URL
   `https://buyhempflowernearme.com/marketplace`.
4. Set Vercel production env (see `.env.example`). `NEXT_PUBLIC_SITE_URL` is
   critical — canonicals, OG URLs and sitemap entries derive from it.
5. Confirm `/marketplace/api/health` reports `"database":"configured"`.
6. When ready: `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_NOTIFICATION_EMAILS`, then
   `BTCPAY_*` once BTCPay is running.

## Recommended next moves

1. **Re-apply 0004 and 0005 to the live database** if the deployment predates
   2026-07-08, and confirm an anonymous product page returns 200.
2. **Commit a test suite** covering the role guards, webhook idempotency and
   `dataMode()`. Nothing currently prevents a regression in the three places that
   would hurt most.
3. **Stand up BTCPay on regtest and settle one order end-to-end** — that closes
   Phase 2 for real.
4. **Turn on Resend**, so vendors and buyers actually hear about decisions.
5. Then Phase 3 in dependency order: shipping adapter → tracking → dispute intake
   → verified reviews. All three trailing items unblock from the shipping adapter.
