---
name: Coach real-account grounding
description: How authenticated coach chat requests ground on the signed-in patient's live data while demo requests keep the seed — the auth ladder, failure posture, and greeting.
---

Coach chat grounds per request via an auth ladder that runs BEFORE the SSE stream opens:

- No bearer token → demo seed path, byte-identical to before (no localDate, no account reads).
- Token resolves to a patient → patient context (name, today's diary totals, targets, program day) derives from live account rows; the client sends its fictional local date (`localDate`) so "today" matches the app's anchor, and program day clamps 1..2000 with created_at fallback.
- Token resolves to staff (not a patient) → demo path; staff browsing the patient app sees the demo coach.
- Token invalid → 401 JSON; account resolution or grounding THROWS → 502 JSON with a retryable friendly message. Never fall back to the demo seed for a signed-in patient — a coach speaking demo data to a real patient is worse than an error bubble.

Because the ladder precedes the stream, all failures are plain JSON (client shows a retryable error bubble); once SSE opens, the usual stream contracts apply. Demo-only server behaviors (e.g. back-on-track outreach branch) are explicitly gated off for real patients until their features go account-aware.

The real-account greeting is composed CLIENT-side from server-provided facts (first name, program day) returned by the transcript load — the greeting is a canned local message (never a model call), so new-conversation cost stays zero and wording stays under the coach-voice constants. Program-day praise is suppressed on day 1.

**How to apply:** any coach/support feature going account-aware follows the same ladder placement (resolve before stream), the same no-silent-demo-fallback rule, and derives patient facts from one server helper rather than re-querying per feature.
