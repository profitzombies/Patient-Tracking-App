---
name: Coach chat safety flags
description: How urgent coach-chat concerns reach the office (PHI-free email + push, in-app review) and the test-fixture trap the office-scope launch gate sets for older route suites.
---

# Coach chat safety flags

**Rule:** the outbound alert (email + provider push) says only that *a* patient's
coach chat needs review and links to `/alerts?chat=<flagId>`; category, reason
and excerpt live in-app only. Screening is urgent-only, real accounts only
(demo never screened), fire-and-forget, and one alert per patient per
office-local day per channel.

**Why:** the owner asked for provider alerts with no patient information in
the message itself; the dashboard is the disclosure boundary.

**How to apply:** new alert kinds join `staff_notifications_kind_check` (the
DB constraint lists kinds explicitly — `office_access_restricted` had been
missing until this work) and the staff-sender kind branch; mobile routes any
staff kind by `kind`, never by a `route` field in the payload.

## Launch-gate fixture trap

Since the practice-launch gate, `resolveOfficeScope` reads `practice_launch`
and, unless `setup_override_at` is set, consults billing mode state (and from
there Stripe). Older route suites whose fakes answer `practice_launch` with a
bare `{required:false}` row — or no table at all — fail every office route
with a 502. Fix the fixture by waiving the gate (`setup_override_at`), the
same posture demonstration offices have; do not mock the gate away unless the
suite is about the gate itself (`billing-permissions` tests it for real).
