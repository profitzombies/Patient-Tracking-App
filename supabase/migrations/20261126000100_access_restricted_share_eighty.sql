-- The restricted revenue share is 80% of floor, not the placeholder 100% the
-- access-billing engine shipped with: a narrowed office still keeps any markup
-- it charges above floor, it simply funds a larger share of the floor price.
alter table public.hq_organization_settings
  alter column access_share_restricted_percent set default 80;

-- Rows still carrying the placeholder never had it applied to a charge (the
-- restricted share was unused until now), so they move to the agreed number.
update public.hq_organization_settings
  set access_share_restricted_percent = 80
  where access_share_restricted_percent = 100;
