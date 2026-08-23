---
name: Range-calibrated analytics
description: How operations pages bound to the shared date range derive deterministic demo figures without breaking approved headline numbers.
---

Pages bound to the shared operations date range must derive every date-bound figure from deterministic seeded series (UTC-noon day indices + the shared seeded hash), **calibrated so the default range reproduces the approved legacy headline numbers exactly** (e.g. Revenue & Outcomes: $184,200 total / $122,200 recurring / $62,000 enrollments, 88.2% / 24.5 lbs / 94.5%). Custom ranges recompute honestly; the comparison window is the equal-length interval immediately prior and returns null — rendered as a labeled "no comparison, data starts Jan 1, 2026" note — when it would predate the synthetic dataset.

**Why:** demo talking points depend on stable headline figures at the default range, while the task contract requires custom ranges to genuinely change values (not just labels). Ranges must also be timezone-invariant (verified identical output under Kiritimati/UTC/Anchorage).

**How to apply:** when binding another operations route to the shared range, extend the existing range-analytics module in the operations app rather than inventing a second seed or editing the static mock dataset (other pages still consume it); pin default-range outputs to the already-approved figures and spot-check with a tsx script across timezones.
