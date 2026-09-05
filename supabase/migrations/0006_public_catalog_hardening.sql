-- 0006_public_catalog_hardening.sql
--
-- Keep the marketplace highly indexable while removing raw anonymous database
-- export paths. Public product/store/review/compliance content is still served
-- by Next.js as HTML + JSON-LD + sitemap. The app's server-side catalog reader
-- uses the service role and keeps explicit live/active/published filters.

begin;

-- ---------------------------------------------------------------------------
-- 1. Anonymous visitors must use the curated storefront surface, not PostgREST
--    table dumps. This does NOT affect Supabase Auth, public HTML, JSON-LD,
--    sitemaps, product images rendered by the app, or authenticated workflows.
-- ---------------------------------------------------------------------------
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
from anon;

-- search_products is consumed by the server-side search layer. PostgreSQL
-- functions default to EXECUTE for PUBLIC, so remove that implicit anon path.
revoke execute on function search_products(text, int) from public;
grant execute on function search_products(text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Fix over-broad image RLS. If table grants are ever relaxed later, images
--    for draft/suspended/delisted listings must still stay private.
-- ---------------------------------------------------------------------------
drop policy if exists images_read on product_images;
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

-- ---------------------------------------------------------------------------
-- 3. Wholesale tiers are not public catalog data. Only the owning vendor,
--    admins, or an explicitly approved wholesale buyer may read exact tiers.
-- ---------------------------------------------------------------------------
drop policy if exists tiers_read on wholesale_price_tiers;
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
