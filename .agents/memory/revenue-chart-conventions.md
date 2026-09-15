---
name: Revenue chart conventions
description: Owner-approved behavior for the pure-SVG payments charts (HQ + office): rest state, running totals, signed domain.
---

Rule: revenue charts show the crosshair/readout card ONLY while the pointer or keyboard is on the chart; at rest the plot stands alone. The "Today" chart plots running totals (each hour = everything since midnight) so lines climb or stay flat. Chart y-domains are signed: a running net can go negative (refund of an older order before the first sale) and must plot below the baseline, never be clamped to $0 while the readout says otherwise.

**Why:** The owner rejected the readout card pinned to the latest slot at rest ("we really don't want to do this") and asked for today's chart to "always be going up" (Sept 2026). The clamp was a review finding: readout and plot disagreed on negative values.

**How to apply:** any new chart on the payments surfaces inherits the shared AreaChart; pass its running flag for cumulative series so the spoken summary reads the last point as the total instead of summing points. Regression lives in the HQ billing verify script (rest = no readout/dots; keyboard engages it; gross path monotone; signed-domain render).
