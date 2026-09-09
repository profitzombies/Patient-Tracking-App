---
name: USDA source portion semantics
description: Preserve separately stored source quantities without replacing them with standard unit conversions.
---

USDA legacy portion quantities, descriptors, and gram weights are one indivisible
source statement. A measure-unit placeholder such as `undetermined` does not mean
the descriptor lacks a usable weight, volume, or household portion. Keep the
quantity in the displayed label and retain the original evidence.

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