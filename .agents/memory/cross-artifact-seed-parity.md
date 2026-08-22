---
name: Cross-artifact seed parity
description: The web dashboard and mobile companion must derive their shared demo story from one fixed anchor date and identical seed logic.
---

**Rule:** The staff dashboard and the mobile companion present the same synthetic patient story. Both must pin the same fixed anchor date (never the viewer's clock), use UTC day arithmetic for date keys, and derive seeded content with identical generator logic and item-pool ordering. The shared demo patient must reproduce the mobile story exactly; other patients vary by design.

**Why:** The demo's credibility rests on both apps agreeing day-for-day for the demo patient (same meals "today", same water totals, same photo captions). A clock-derived "today", local-time date math, or a reordered item pool silently forks the story between the two apps and across timezones — and it can look correct on the day it ships.

**How to apply:** When touching either app's seeded data (recipes, targets, formulas, anchor date), mirror the change on the other side and keep list ordering intact. The web app's demo-parity snapshot (`test:parity` in thinnr-operations) must pass in multiple timezones; update its expectations deliberately only when the shared story is meant to change.
