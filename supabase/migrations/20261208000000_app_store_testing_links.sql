-- Store links may be pre-release testing links while the listings are in
-- review: TestFlight public links (testflight.apple.com/join/…) and Google
-- Play internal/closed testing opt-in pages (play.google.com/apps/internaltest/…
-- and /apps/testing/…). Patient invitations switch from the Expo Go page to
-- these links as soon as HQ saves one, so the shape check widens in lockstep
-- with the API (APP_STORE_URL_RE / GOOGLE_PLAY_URL_RE) and the web form.
--
-- The original CHECKs were created inline by the add column statements, so
-- their names are the Postgres defaults.

alter table public.hq_organization_settings
  drop constraint if exists hq_organization_settings_app_store_url_check,
  drop constraint if exists hq_organization_settings_google_play_url_check;

alter table public.hq_organization_settings
  add constraint hq_organization_settings_app_store_url_check
    check (app_store_url is null or (
      char_length(app_store_url) <= 500
      and app_store_url ~ '^https://((apps|itunes)\.apple\.com/|testflight\.apple\.com/join/)'
    )),
  add constraint hq_organization_settings_google_play_url_check
    check (google_play_url is null or (
      char_length(google_play_url) <= 500
      and google_play_url ~ '^https://play\.google\.com/(store/apps/details\?|apps/(internaltest|testing)/)'
    ));
