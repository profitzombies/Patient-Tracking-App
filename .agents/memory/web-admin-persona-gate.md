---
name: Web admin persona gate
description: How to visually verify THINNR operations admin pages — they sit behind the sign-in gate, so static screenshots only show the sign-in card.
---

Operations-web admin routes (`/admin/...`) render the sign-in page for anonymous visitors; the guided-demo bypass stores a persona in **sessionStorage**, which the static Screenshot tool cannot set.

**Why:** a direct screenshot of any admin deep link returns the "THINNR Operations" sign-in card, which is easy to misread as a broken page.

**How to apply:** verify admin UI through the testing subagent: expand "Exploring? Browse the guided demo without an account" on `/`, pick the HQ (or office) persona, then deep-link in the same tab session. Supabase-backed writes are read-only (friendly nudge toast), but session-local HQ writes work — e.g. adding a provider account succeeds (sessionStorage-backed) — so layout checks are safe and session-scoped write flows are testable. Real course/video ids for deep links come from Supabase REST (`training_videos.module_id` → `training_modules.course_id`; videos have no direct course column).

**Live-data admin pages need a REAL HQ login — the demo persona is 'unauthorized' there by design.** Live HQ surfaces (e.g. the provider directory) gate on a real signed-in active HQ membership, so the guided-demo persona showing the "Sign in with a THINNR HQ account…" nudge is correct behavior, not a bug. To verify them, provision a disposable INVITED HQ membership with a pending invitation via the service role (the passwordless verify activates it on first sign-in), have the tester flip email delivery to dev mode so the code shows inline, mind the shared per-email send cap, and delete the QA identity afterwards. If a good login still looks blocked, curl the server-side HQ session resolver with that user's bearer first — it is authoritative over browser state.
