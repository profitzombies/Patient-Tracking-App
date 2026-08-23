---
name: Parallel design-variant data parity
description: When several subagents build variants of one screen from a shared data spec, they drift on state semantics; review must check parity
---
When fanning out parallel design subagents that all render one shared demo-data spec, each round some variant drifts — not on numbers, but on **semantic state encodings**: a minus sign dropped because the label says "down", a "logged" day drawn as an outlined (empty-looking) marker, a streak count that contradicts a meal row.

**Why:** each subagent re-interprets the spec independently; visual encodings of state (filled vs outlined, sign vs label) feel like style choices to a designer but read as data to anyone comparing frames side by side.

**How to apply:** include the full verbatim data spec in every variant brief AND in the post-build architect review prompt, stating explicitly that visual state encodings count as data. Expect the review to flag 1-2 real parity bugs per fan-out round; they are one-line fixes — make them in place (bug fixes are the exception to "never edit variants in place"). Also require each brief to demand a passing sandbox typecheck; one variant per round tends to break it.
