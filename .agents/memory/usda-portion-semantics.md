---
name: USDA source portion semantics
description: Preserve separately stored source quantities without replacing them with standard unit conversions.
---

USDA legacy portion quantities, descriptors, and gram weights are one indivisible
source statement. A measure-unit placeholder such as `undetermined` does not mean
the descriptor lacks a usable weight, volume, or household portion. Keep the
quantity in the source evidence. A normalized display can show individual units
instead, but it must carry the exact relationship to the original source amount.

**Why:** A source `amount: 4`, modifier `oz` becomes four ounces' nutrition under a
one-ounce-looking label if the amount is lost. Conversely, independently
converting those four ounces can falsify the archived gram weight: the
cottage-cheese source records say 113 g, not a calculated 113.4 g. A synthetic
fixture had initially assumed the calculated value.

**How to apply:** Preserve the source portion alongside distinct standard-unit
conversions. Validate generated snapshots with the actual mobile parser and
calculator against immutable source records, not merely SQL shape/count checks.
Missing-value fixture coverage must be labeled synthetic when the reviewed
source population contains no missing-amount rows.

Use semantic unit classification at every serving transition, not just during
initialization. A structured source-helper dimension can incorrectly classify
literal fluid ounces as weight.

**Why:** Correcting fresh defaults alone leaves later unit/preparation changes
using incompatible conversion rules despite an apparently valid snapshot.

Keep original archives, checked-in projection documents, and deployed catalog
snapshots as separate evidence levels during audits. Missing numeric amounts in
FNDDS can be intentional: the amount is expressed in the portion description.

**Why:** Legacy projections can demonstrate a quantity-loss mechanism without
establishing its current live prevalence. Treating every release like SR Legacy
also falsely classifies FNDDS's description-based portions as missing data.

**How to apply:** Verify archive hashes and exact release/food/portion identities.
Report reproducible rule failures separately from stored-row findings, and mark
live impact unmeasured unless the actual food-only deployed population was read.

**How to apply:** Recognize documented volume units without inventing density.
Keep original labels and gram weights unchanged, and validate initial selection,
unit changes, and type changes through the same semantic classification.