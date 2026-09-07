---
name: Push notification outbox
description: Policy decisions behind the server-side patient push pipeline — where suppression is decided, why the lease is proven on real PostgreSQL, quiet-hours DST rule, and how device proof works.
---
Rule: every server-originated patient push is an outbox row and nothing calls the Expo push API outside the sender. Delivery policy (category off, opt-out, quiet hours, no device) is decided AT SEND TIME and the reason is persisted on the row — never pre-filtered at enqueue.

**Why:** staff need the audit trail ("suppressed: quiet hours" vs "never queued"), and quiet-hours rows must defer and later send, which only works if the row already exists. Multi-process safety rests on a `for update skip locked` lease RPC; an in-memory fake cannot prove that, so the suite boots a temp PostgreSQL cluster and races two claimants.

**How to apply:**
- New notification kinds enqueue through the store with a dedupe key and let the sender handle policy; do not add policy checks at enqueue sites.
- Quiet-hours end is a LOCAL wall time: resolve its instant with the zone offset in force at that wall time, not at "now" (code review rejected the at-time offset: fall-back nights sent an hour early). Nonexistent times → first instant after the gap; ambiguous → later occurrence.
- Coach outreach is evaluated server-side with the same rules as the mobile assessment; a dual-import parity test pins them. Seeded thread message ids use a `coach-outreach:` prefix and the quick-reply labels are a wire contract shared with the demo outreach.
- Roster route-test fakes must answer the outreach-states RPC alongside the activity aggregate, or every roster test 502s.
- The internal tick route is invisible (404) until its bearer knob is set — by design, not a bug.
- Expo Go (SDK 53+) cannot receive remote push; device-level proof needs an EAS development build with the project id env set. Everything below the device is provable with the fake push service.
