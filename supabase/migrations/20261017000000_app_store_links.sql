-- App store listing links: HQ sets the App Store and Google Play URLs once on
-- the organization settings singleton; every office portal renders QR codes
-- from them (no per-office copy). Both stay optional — a null link shows the
-- office an "HQ hasn't added this link yet" notice instead of a code. Shape
-- checks mirror the API's validation so a bypassing write cannot smuggle a
-- non-store URL onto every practice's front-desk sheet.

alter table public.hq_organization_settings
  add column if not exists app_store_url text
    check (app_store_url is null or (char_length(app_store_url) <= 500 and app_store_url ~ '^https://(apps|itunes)\.apple\.com/')),
  add column if not exists google_play_url text
    check (google_play_url is null or (char_length(google_play_url) <= 500 and google_play_url ~ '^https://play\.google\.com/store/apps/details\?'));
