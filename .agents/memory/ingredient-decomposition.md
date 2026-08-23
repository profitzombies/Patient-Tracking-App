---
name: Per-ingredient nutrition decomposition
description: Contract for recipe ingredient breakdowns — exact curated sums, original-baseline scaling, delta totals, server normalization, where adjustments persist.
---

Recipes (curated, coach, saved) optionally carry `nutrition` per ingredient = that ingredient's contribution to ONE serving at its listed amount.

**The contract:**
- Curated catalog rows decompose EXACTLY: integer per-ingredient values summing to each recipe's stated per-serving totals, per macro. Amount-0 ("to taste") rows stay bare — no nutrition key, not expandable. The recipe-nutrition suite pins this.
- Every rescale derives from the ingredient's ORIGINAL amount/unit (scale factor = current ÷ original after unit conversion). Never rescale an already-rescaled value; repeated edits must be bit-identical to a direct set.
- Screen totals use the delta method: `stated + Σ(scaled − original)`, clamped ≥0, so an unadjusted recipe shows exactly its stated values (no round-trip drift). Round once, at display/log boundaries only.
- Unit conversions are linear within families (weight oz/lb, volume tsp/tbsp/cup); cross-family is null → treated as invalid, row degrades to unchanged instead of NaN.
- The coach pipeline REQUIRES nutrition on every AI card ingredient (zeros fine for water/seasonings); sums are tolerance-checked (per-serving or ×servings batch basis) with the one-corrective-retry pattern, then largest-remainder normalized so payload integers sum exactly to the rounded card totals. Mobile parsing stays lenient: malformed nutrition drops to totals-only, the card survives.

**Why:** compounded rounding and mixed baselines were the failure modes this design dodges; exact curated sums make drift detectable by equality, not tolerance.

**How to apply:** any new surface that edits amounts must store adjustments as `{index, amount, unit}` against the ORIGINAL ingredient list and recompute via the shared helpers (data/ingredient-nutrition.ts), not ad-hoc math. Diary entries persist adjustments ONLY when recipe-linked (refId resolvable) so the breakdown can reopen; Library saves keep the coach's original amounts — session adjustments shape only what gets logged. The " · adjusted" detail suffix is the user-visible marker; strip/add it only through the entry-edit state helpers.
