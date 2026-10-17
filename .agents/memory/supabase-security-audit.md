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

**Baseline 2026-10-16 (both projects identical unless noted):** site_url localhost, no redirect allow-list, public signup on, email autoconfirm on, no custom SMTP, captcha off, pw min 8 + HIBP on, inactivity timeout 4320 h, refresh rotation on, SSL enforcement off, DB network open 0.0.0.0/0, PITR off (daily backups on), legacy anon/service_role keys active alongside new publishable/secret keys. Prod schema lagged dev by the office-kind/reseller migrations.
