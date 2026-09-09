---
name: Live office leaderboard
description: Durable rules for the staff leaderboard that ranks real patients — where numbers are computed, how live/demo branches are chosen, and the local-day trap at the route boundary.
---

**Rule:** the leaderboard never invents a number client-side. One service-role SQL RPC returns per-patient period facts on each patient's OWN local day; the server applies eligibility, competition ties and the documented adherence formula and ships the definition text in the response. Clients only re-sort by the server rank of the chosen metric.

**Why:** the old board fabricated an adherence figure; staff need a definition they can defend, and web and mobile must agree to the digit.

**How to apply:**
- New metrics go into the RPC + ranking module + response definitions, never into a page. Not-rankable patients are a separated count with reasons, never a zero-score row.
- Branch choice (live vs seeded) follows AUTH STATE, never missing data — a live failure shows an error, not seeded rows.
- **Local-day trap:** anything day-granular derived per patient at the route boundary (program day, stage, "as of") must use that patient's local day from the facts, not one request-wide UTC date — around UTC midnight a single date shifts patients west/east of UTC onto the wrong day and the stage filter picks the wrong cohort. Test it with fake timers at ~03:00 UTC and a patient in a US zone on a stage boundary.

- **office=all is not a separate auth path:** resolve through the shared office ladder and treat only the HQ rung's "office required" outcome as permission for the network-wide board; a dual-role owner/teammate with an HQ membership stays pinned to their own office.

**Why the smoke path is odd:** service-role-gated RPCs cannot be exercised through the management API (it runs as a different role); exercise them via the API route with a real office identity.
