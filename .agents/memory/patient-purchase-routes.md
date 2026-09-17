---
name: Patient purchase routes and demo write posture
description: Route-name collision for patient subscription screens, the demo-mode write posture reviewers/testers misread, and the move-date window rule.
---

**Rule:** Patient self-service billing screens live at `/orders` and `/my-subscriptions`, never `/subscriptions`.

**Why:** `/subscriptions` is already the staff tab and a staff-owned prefix in the persona gate, so a patient route with that name collides on Expo web and gets redirected as staff. Server push routes and in-app links share the prefix.

**How to apply:** Before adding any patient-facing route, check the staff tab group and the staff-route prefix list for a name clash.

**Demo write controls:** demo persona renders billing action buttons dimmed with `accessibilityState.disabled` (aria-disabled on web) and an explaining nudge on tap, deliberately not DOM `disabled`. A tester reporting `disabled=false` on those buttons is describing the intended pattern. Detail-screen back is history back; arriving from an order's "View subscription" returns to that order by design.

**Move-date window:** the API reads a date-only pick as noon UTC and requires 1..365 days from now; the client picker bounds must be derived from that same rule (not local calendar days) or evenings west of UTC show a "tomorrow" the API rejects.

**Keyset pages over billing rows:** cursors carry `(created_at, id)`; the continuation predicate must be lexicographic (`created_at < c OR (created_at = c AND id < id)`), not `created_at <` alone, or rows sharing the boundary instant vanish from every later page. Prove it with a fixture that puts more tied timestamps than fit on one page.
