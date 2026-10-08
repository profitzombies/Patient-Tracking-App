---
name: Web admin pages need a real HQ login (no demo persona)
description: How to verify operations-web /admin and office pages now that the guided-demo persona is gone — screenshots show only sign-in; use a disposable real HQ login through the testing subagent.
---

Operations-web admin and office routes render the sign-in page for anonymous visitors. The guided-demo persona bypass (sessionStorage) was deleted on 2026-10-08, so there is no signed-out way to render those screens anywhere — not in development either.

**Why:** the user asked for every demo entry point to go once the published app had no demo. The static Screenshot tool therefore only ever sees the sign-in card for any staff route.

**How to apply:** verify staff surfaces through the testing subagent with a REAL login. Provision a disposable INVITED HQ membership with a pending invitation via the service role (the passwordless verify activates it on first sign-in), have the tester flip email delivery to dev mode so the code shows inline, mind the shared per-email send cap, and delete the QA identity afterwards. Office pages need a directory-backed staff member linked to an active, unlocked, launch-waived provider. If a good login still looks blocked, curl the server-side HQ session resolver with that user's bearer first — it is authoritative over browser state. Hermetic page suites (react-test-renderer) are the right place for layout checks that used to ride the demo persona.
