---
name: Supabase e2e auth seeding
description: How to create/verify/clean up throwaway auth users for browser e2e when hosted Supabase blocks signup emails.
---

Hosted Supabase blocks two things that break "just sign up a test user via the API":

- `@example.com` (and similar reserved domains) is rejected by `/auth/v1/signup` with "Email address invalid". Use a made-up but non-reserved domain instead.
- The built-in mailer rate limit (a few emails/hour) returns 429 on signup itself when email confirmation is on — even failed attempts can consume it.

**How to apply:** seed e2e users directly in SQL, then prove sign-in via the token endpoint before dispatching browser testers:

1. `insert into auth.users` with: `instance_id '00000000-0000-0000-0000-000000000000'`, `aud`/`role` = `'authenticated'`, `encrypted_password = crypt(pw, gen_salt('bf'))`, `email_confirmed_at = now()`, and the token columns (`confirmation_token`, `recovery_token`, `email_change`, `email_change_token_new`, `email_change_token_current`) set to `''` (GoTrue chokes on NULLs there).
2. Matching `auth.identities` row: `provider 'email'`, `provider_id = user_id::text`, `identity_data` with `sub`/`email`/`email_verified`.
3. Any `on auth.users insert` trigger (e.g. allowlist role assignment) fires normally — verify its side effects with a SELECT.
4. Prove login works: `POST {url}/auth/v1/token?grant_type=password` with the apikey header → expect `access_token`.
5. Cleanup: `delete from auth.users where email like ...` — FK cascades remove profiles/identities.

**Why:** the 429 stalls the whole verification pipeline for an hour otherwise, and SQL-seeded users exercise the same trigger path as real signups.

Related: to verify the mobile app serves new auth code, grep the bundle fetched from the **public Expo dev domain** — localhost:8081 belongs to the mockup sandbox in dev, and Metro sits on the artifact-assigned port.
