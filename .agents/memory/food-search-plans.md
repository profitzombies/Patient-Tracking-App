---
name: Grouped food-search plans
description: Guard against planner fan-out and wide-row spills when reviewed food families grow.
---

Materialize the matched-family boundary before lateral variant selection.
Aggregate narrow alias text separately, then join nutrition-bearing rows.
Treat all query and alias tokens as literal text, including internal aliases.

**Why:** Catalog growth let the planner run variant selection for nearly every
family before narrowing to actual matches. Grouping full nutrition snapshots
also spilled wide rows to temporary storage. Small-catalog correctness checks
had not exposed the cost. Source-derived alias punctuation separately exposed
unsafe regular-expression interpolation.

**How to apply:** Preserve result equality while inspecting EXPLAIN ANALYZE for
lateral loop counts and temp reads. Include unsupported preparation queries and
verifier-shaped batches, not only popular exact-name HTTP searches. Keep a fast
literal-escaping contract when optimizing; never gain speed by loosening food
identity or constraint matching.

Recognize literal food-identity phrases before consuming generic preparation
words. Canonical-name words may be identity-bearing; a variant-bearing alias
must still retain its constraints.

**Why:** “Frozen Yogurt” is not ordinary yogurt with a frozen filter. Hyphens,
“dry,” “whole,” and similar words exposed the same boundary when the family
population expanded. Clearing constraints for every matched alias would
instead break requests such as raw chicken wings.

**How to apply:** Compare exact canonical and bounded alias winners, then test
extra modifiers in both word orders and deliberately incompatible combinations.
Keep result-order cursor versions in sync with semantic search changes.

Reject contained identities with unparsed remainder before they can suppress
singleton results. Preserve all-row negative checks, not only first winners.

**Why:** A correct Apple Pie winner did not make it safe to include Apples later
in the same result set. Shorter false family hits also hid valid puffed cereals.
NULL-valued SQL comparisons can silently pass assertions on empty results.

**How to apply:** Require complete identity-plus-modifier coverage, explicitly
assert nonempty positive results, and use null-safe comparisons in SQL gates.
Preflight normalized query ownership across old and proposed corpora. When a
new group duplicates an old one, preserve source records/defaults with an
auditable reconciliation and generic legacy-key redirects; remembered search
configurations need redirect aliases through SQL, API normalization and mobile.