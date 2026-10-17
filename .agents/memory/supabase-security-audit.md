---
name: Supabase security audit recipe & posture
description: How to audit the prod/dev Supabase projects safely (what leaks secrets, what is by design) and the posture baseline found 2026-10-16.
---

**Rule:** the management API `GET /v1/projects/<ref>/postgrest` returns `jwt_secret` in plaintext. Always pipe management-API responses through a jq allowlist before printing; never dump raw JSON. (The 2026-10-16 audit printed it once into the chat log; rotation was recommended to the owner.)

**Why:** audit output lands in transcripts/checkpoints that outlive the session.

**How to apply:** for `/config/auth`, `/postgrest`, `/api-keys` use `?reveal=false` and `jq '{allowlisted keys}'`. Through the MCP callbacks, SQL results come back wrapped: parse by slicing from the first `"\n["` to the last `"]"` after the untrusted-data tag.

**By-design facts (don't re-flag):**
- ~156 tables show "RLS enabled, no policy": intentional — API uses service role; anon/authenticated get nothing.
- `patients` has an own-row UPDATE policy but NO UPDATE grant to authenticated, so it is inert; all writes ride the API.
- All account creation uses `/auth/v1/admin/*` (service role), so GoTrue `disable_signup=true` is safe to turn on.
- Training learner RPCs are anon-callable SECURITY DEFINER on purpose (email → session token). Known weakness: any email already on `training_viewers` yields that viewer's row (name/phone/office) and lets a stranger mark completions.
- Default ACLs still hand anon/authenticated full table privileges on newly created tables (barcode_nutrition_facts, billing_carts, billing_prebuilt_carts, billing_shipments, knowledge_documents, training_video_transcripts); RLS blocks them today, but new tables should get an explicit `revoke all from anon, authenticated`.

**Applied 2026-10-16 (both projects):** network restrictions = no CIDRs, SSL enforcement on, `disable_signup=true`, site_url + allow-list set, grant-hardening migration ledgered with runner postconditions. Deliberately NOT done: moving pg_trgm out of `public` (food-search functions call `similarity()` unqualified under `search_path=public`; moving the extension breaks search unless every one of those functions is re-pathed first), JWT-secret rotation / legacy-key disable (signs everyone out, needs deployment + EAS secret updates), inactivity timeout (patient persistence is a feature), training-gate email verification (flow change), PITR (paid).

**Baseline before hardening, 2026-10-16 (both projects identical unless noted):** site_url localhost, no redirect allow-list, public signup on, email autoconfirm on, no custom SMTP, captcha off, pw min 8 + HIBP on, inactivity timeout 4320 h, refresh rotation on, SSL enforcement off, DB network open 0.0.0.0/0, PITR off (daily backups on), legacy anon/service_role keys active alongside new publishable/secret keys. Prod schema lagged dev by the office-kind/reseller migrations.
