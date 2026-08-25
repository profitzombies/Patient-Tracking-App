---
name: Phone-width table overflow
description: Why a table inside overflow-x-auto can still widen the whole page, and what sets a table cell's minimum width.
---

Two rules for data tables at phone widths:

1. **An absolutely-positioned element (e.g. Tailwind `sr-only`) inside an `overflow-x-auto` wrapper escapes it when no ancestor is positioned.** Its containing block becomes the initial containing block, so it sits at its static position at the table's full width and stretches the *document*, not the wrapper. Fix: add `relative` to its parent cell (or any ancestor inside the wrapper).
   - Diagnostic signature: `documentElement.scrollWidth > body.scrollWidth` (fixed/ICB-anchored offenders don't count toward body). A rect-walk for offenders can come up empty if run before the table renders — measure after rows are visible.
2. **A `truncate` block's `max-width` cap IS the cell's min-content width in the table layout algorithm** (nowrap text is capped only by max-width; overflow:hidden doesn't shrink intrinsic size). A generous cap like `max-w-[11rem]` on a secondary line silently forces internal scroll at 390px. Size caps per breakpoint (`max-w-[7.5rem] sm:max-w-[11rem]`), and hide secondary columns below `sm` like the codebase already does for Watch time/Email/Office.

**Why:** the office Training roster passed desktop checks but measured 491px on a 390px phone — the sr-only header span escaped the wrapper; after containing it, an email truncation cap still forced 32px of internal scroll.

**How to apply:** any time a table gains a column or an sr-only header, re-measure at 390px: page `scrollingElement.scrollWidth` AND the wrapper's `scrollWidth vs clientWidth` (internal scroll hides trailing affordances like chevrons even when the page fits).
