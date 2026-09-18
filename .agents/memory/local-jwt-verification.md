---
name: Local JWT verification & session revocation list
description: Why API identity is verified locally, why a server-side revocation list exists, and the two traps around ending Supabase sessions from the server.
---

**Rule:** verify bearer tokens locally (JWKS) by default; one route-policy module names the few families that still confirm remotely (money writes, privacy/deletion, security settings). After either path, check the token's `session_id` against the server's revocation list.

**Why:** Supabase Auth rate limits sit far below the database's, and local verification cannot see server-side sign-outs on its own.

**Trap 1 — GoTrue has no per-user admin logout route on this project.** `POST /auth/v1/admin/users/{id}/logout` answers `404 page not found`; the code relied on it for years and every "sign out everywhere" silently did nothing. Ending a session = deleting its `auth.sessions` row (refresh tokens cascade), which is what GoTrue's own global logout does.

**Trap 2 — never split "list sessions" from "end sessions".** Reusing the display RPC (capped at the newest 100 rows) to build the revocation list, then deleting all sessions, leaves session 101+ unlisted and races with logins in between. Review rejected that; the fix is one SQL statement (CTE delete … returning → insert revocations) so a session cannot be ended without being listed, and a refusal signs nothing out.

**How to apply:**
- New route families needing instant remote revocation go in the policy module only. New sign-out paths call the one revoke helper; check the list on remote paths too.
- Tests must include a >100-session sign-out and a login opened after the sweep staying valid; prove the RPC live once (two sessions, spare one, refresh grant 400, anon 401).
- JWKS rotation tests must advance fake time past the refresh cooldown; non-JWT fake tokens keep flowing through the remote path, so old route fakes need no signer.
