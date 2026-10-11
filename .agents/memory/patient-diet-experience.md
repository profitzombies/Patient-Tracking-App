---
name: Patient diet experience (mobile)
description: Durable rules for the patient-app diet slice — picker outcomes, onboarding write ordering, fit evidence by phase, queued list edits, and the render-suite timing traps.
---

# Patient diet experience (mobile)

**Rules**
- Diet state lives OUTSIDE PersistedState. The picker is one awaited `selectDiet` whose outcome maps from the
  HTTP status (200 active / 202 pending review / 409 locked / 422 screening required). Lists, activity,
  screening, settings and targets ride the offline write queue; the protocol lock is terminal.
- Onboarding diet writes fire AFTER server-confirmed completion and never throw into the completion path.
  The female-only pregnancy question reads the server profile's gender, so setup must send it.
- Fit evidence: only the seeded catalog (`fd_*`) was reviewed against the Approved Foods list. A seeded id off
  the list is "not approved"; everything else — custom foods, recipes, shared catalog hits, missing ids — is
  unknown (no badge). A shared hit's `approved: false` means "no approval recorded", never "not approved";
  the rule must hold at BOTH seams (id bridge and the food-description flag reader).
- Diet writes are intent writes: they never carry `editIds` and the queue reconciler skips them outright,
  because it only knows diary/library/photo truth and would drop a pending diet edit on restart or refresh.
  Edits made while an add's POST is in flight queue under the local id and are re-pointed to the server id
  on ack (409 duplicate → match list+key). Chosen over cancelling requests: the server may already have the row.
- Existing-account prompt: onboarding complete + no `allergiesNone` key + no seen flag + no diet + no allergy
  rows. "None" counts as answered.

**Why:** owner decisions 2026-10-09 (diet steps at the END of onboarding, completion never blocked); two
review rounds caught non-catalog foods badged "doesn't fit" and queued diet edits lost on restart.

**How to apply (render suites):** backoff is `min(maxDelayMs, base·2^n)` — raise BOTH knobs to observe a local
id. Hold a request in the fake fetch to test in-flight edits; assert on the fake server's own removal log
(add + follow-up can land within one poll tick). Fake `Response` objects need `headers` — the API reader calls
`headers.get`, and a missing field reads as "server unreachable", not as a test error.
