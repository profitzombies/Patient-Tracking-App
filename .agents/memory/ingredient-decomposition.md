---
name: Per-ingredient nutrition decomposition
description: Contract for recipe ingredient breakdowns — exact curated sums, original-baseline scaling, delta totals, server normalization, where adjustments persist.
---

Recipes (curated, coach, saved) optionally carry `nutrition` per ingredient = that ingredient's contribution to ONE serving at its listed amount.

**The contract:**
- Curated catalog rows decompose EXACTLY: integer per-ingredient values summing to each recipe's stated per-serving totals, per macro. Amount-0 ("to taste") rows stay bare — no nutrition key, not expandable. The recipe-nutrition suite pins this.
- Every rescale derives from the ingredient's ORIGINAL amount/unit (scale factor = current ÷ original after unit conversion). Never rescale an already-rescaled value; repeated edits must be bit-identical to a direct set.
- Screen totals use the delta method: `stated + Σ(scaled − original)`, clamped ≥0, so an unadjusted recipe shows exactly its stated values (no round-trip drift). Round once, at display/log boundaries only.
- Unit conversions are linear within families (weight oz/lb, volume tsp/tbsp/cup/fl oz); cross-family is null → invalid, row degrades to unchanged instead of NaN — EXCEPT where the measure bridge (below) supplies a factor.
- **Measure bridge (ounce options):** a name-keyed table (data/ingredient-measures.ts: liquid flag, ozPerCup, ozPerPiece) extends a row's unit options — fl oz for liquids (pure volume, 1 cup = 8 fl oz; liquids NEVER bridge to weight), weight oz for solids via ozPerCup/ozPerPiece, bridging weight↔(volume|count) only, all routed through oz. Name matching: exact map first, then stemmed keyword phrases, most tokens wins, ties to the LATEST-ending match (head-noun rule: "almond milk" liquid, "milk chocolate chips" solid); no generic one-token entries that could steal matches. Unrecognized names (e.g. novel AI-card ingredients) keep their family-only options — never invent densities. Converted amounts snap to the exact original when within 1e-6 relative, so unit round-trips restore the bit-exact original and sanitize's return-to-original deletion fires.
- The coach pipeline REQUIRES nutrition on every AI card ingredient (zeros fine for water/seasonings); sums are tolerance-checked (per-serving or ×servings batch basis) with the one-corrective-retry pattern, then largest-remainder normalized so payload integers sum exactly to the rounded card totals. Mobile parsing stays lenient: malformed nutrition drops to totals-only, the card survives.

**Why:** compounded rounding and mixed baselines were the failure modes this design dodges; exact curated sums make drift detectable by equality, not tolerance.

**How to apply:** any new surface that edits amounts must store adjustments as `{index, amount, unit}` against the ORIGINAL ingredient list and recompute via the shared helpers (data/ingredient-nutrition.ts), not ad-hoc math. Diary entries persist adjustments ONLY when recipe-linked (refId resolvable) so the breakdown can reopen; Library saves keep the coach's original amounts — session adjustments shape only what gets logged. The " · adjusted" detail suffix is the user-visible marker; strip/add it only through the entry-edit state helpers.
