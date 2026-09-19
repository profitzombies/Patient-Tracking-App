---
name: Shared dev DB drift during live browser checks
description: Concurrent tasks seed fixtures into the same Supabase project mid-run; brief testers to compare against the app's own response, not fixed numbers.
---
Rule: when a browser tester verifies a live HQ analytics page, brief it to compare rendered figures against the JSON of the app's own 200 response in that same step (plus a stable anchor row that must always be present), never against a fixed baseline taken minutes earlier.

**Why:** a retention run "failed" because two synthetic offices appeared between the first load and the recovery step — another in-flight task's care-team smoke harness had inserted provider rows into the shared dev project. The page was right; the baseline was stale. Testers stop early on such a mismatch and burn a session.

**How to apply:** take the baseline with the same RPC the route uses right before dispatch, but phrase assertions as "tiles == response.network.counts, rows == response.offices[]" with one known anchor office; when a mismatch appears, re-query the DB before treating it as a bug. Expect `care-*` / "Synthetic … Office" providers to come and go.

**Disposable HQ admin for live-gated pages:** invite via the `hq_invite_team_member_v2` RPC acting as the active super_admin (invited membership + pending invitation, random SHA-256 token hash); the passwordless verify creates the auth user and accepts the invite. The tester performs the CLAIM_EMAIL_DELIVERY_MODE=dev override restart itself and the no-override restart afterwards; one code request is enough (shared send cap). Cleanup order: claim_verifications by identifier → hq_invitations → hq_memberships → auth admin user → any throwaway providers rows; keep the helper script under gitignored `tmp/` with an absolute state-file path (pnpm --filter runs it from the package dir).
