-- 0006_public_catalog_hardening.sql
--
-- SEO-safe catalog hardening: public HTML, JSON-LD, sitemaps, images and search
-- remain available through Next.js, while raw PostgREST table/RPC export paths
-- are closed. The server-side catalog reader uses the service role and keeps
-- explicit live/active/published/verified filters.

begin;

-- Public and signed-in browsers use the curated application surface, not raw
-- catalog tables. Revoking authenticated SELECT matters because otherwise a
-- scraper could simply create an account and regain the machine-perfect dump.
-- Supabase Auth itself is unaffected; protected application reads/writes are
-- mediated by server route handlers using the service role.
revoke select on table
  categories,
  vendors,
  vendor_badges,
  products,
  product_variants,
  product_images,
  wholesale_price_tiers,
  compliance_records,
  reviews
from anon, authenticated;

-- Search is rendered through the server-side application layer. Remove the
-- default PUBLIC execute grant so callers cannot enumerate product ids/ranks by
-- hitting the Supabase RPC directly.
revoke execute on function search_products(text, int) from public;
revoke execute on function search_products(text, int) from anon, authenticated;
grant execute on function search_products(text, int) to service_role;

-- If table grants are ever relaxed later, images for non-live listings still
-- remain invisible except to the owner/admin. Drops make this migration safe to
-- re-run in the repository's current forward-apply deployment scripts.
drop policy if exists images_read on product_images;
drop policy if exists images_scoped_read on product_images;
create policy images_scoped_read on product_images for select using (
  exists (
    select 1
    from products p
    where p.id = product_images.product_id
      and (
        p.status = 'live'
        or p.vendor_id = my_vendor_id()
        or is_admin()
      )
  )
);

-- Exact wholesale tiers are operational data, not public SEO data. Keep a
-- defense-in-depth RLS rule for a future server/API path that deliberately
-- operates with a user JWT instead of the service role.
drop policy if exists tiers_read on wholesale_price_tiers;
drop policy if exists tiers_authorized_read on wholesale_price_tiers;
create policy tiers_authorized_read on wholesale_price_tiers for select using (
  is_admin()
  or exists (
    select 1
    from product_variants pv
    join products p on p.id = pv.product_id
    where pv.id = wholesale_price_tiers.variant_id
      and p.vendor_id = my_vendor_id()
  )
  or exists (
    select 1
    from product_variants pv
    join products p on p.id = pv.product_id
    join wholesale_access wa
      on wa.vendor_id = p.vendor_id
     and wa.buyer_id = auth.uid()
     and wa.status = 'approved'
    join wholesale_profiles wp
      on wp.profile_id = auth.uid()
     and wp.approved = true
    where pv.id = wholesale_price_tiers.variant_id
      and p.status = 'live'
  )
);

commit;
