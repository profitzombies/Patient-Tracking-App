# Food portions and conversions: read-only audit

**Date:** 11 September 2026  
**Scope:** Repository data, original cached USDA releases, and actual conversion functions. **Not a live database census.** No foods, historical diary entries, provider data, schemas, or runtime screens were changed.

## Decision summary

The source archives are intact. The main risks are in projections and conversion rules, not evidence that the underlying USDA data needs rewriting.

| Priority | Finding | What is confirmed | Live-record impact |
| --- | --- | --- | --- |
| P1 | F1: Older projections lose the source quantity | 13 distinct multi-ounce source portions have an `oz` label without their 3- or 4-ounce quantity in checked-in legacy projections | Not measured; newer helper preserves quantities, but older migration paths require a scoped check |
| P1 | F2: Recipe conversion ignores preparation and cut form | Cooked spinach, cooked broccoli, uncooked quinoa, and postfixed sliced/ground almonds resolve to unsuitable cup weights | Rule reproduced; no patient usage/history inspected |
| P1 | F3: “Without salt” selects salt's weight | The exact stored cooked-food descriptions resolve to the salt conversion rather than the food | Rule reproduced; no claim that these strings occur in saved patient recipes |
| P2 | F4: Contradictory gram evidence passes validation | A synthetic 200 g cup can scale nutrition as 150 g | Validation gap, **not** an observed corrupt stored food |
| P2 | F5: Partial nutrition snapshots can leave totals unscaled | A synthetic double portion logs baseline calories when one or more macros are absent | Fallback gap, **not** an observed incomplete live snapshot |

P1 means resolve before expanding or relying on the affected conversion path. P2 means strengthen admission/validation without altering historical records. These are data-integrity priorities, not clinical severity assessments.

## What was checked

The offline runner verifies each original JSON file's SHA-256 against its committed release manifest, scans its records, and compares frozen food-only projections to the original portion fields. AI was used only to nominate candidates. Findings below rely on stored fields, executable application functions, and arithmetic, not AI estimates of nutrition.

| Population | Foods / comparison rows | Portions | Result |
| --- | ---: | ---: | --- |
| Original SR Legacy, April 2018 | 7,793 | 14,449 | Original-byte hash and counts match |
| Original FNDDS, 2021–2023 distribution | 5,432 | 22,194 | Original-byte hash and counts match |
| Original Foundation, April 2026 | 363 | 383 | Original-byte hash and counts match |
| Frozen everyday source review | 118 | 345 | No discrepancy in amount, grams, modifier, description, or unit |
| Frozen bulk source candidates | 5,121 | 9,456 | No discrepancy in those fields |
| Earlier family review documents | 46 entries | See evidence receipt | All 184 core nutrient comparisons match the original source; quantity-label losses described below |
| Static `FOOD_DB` | 79 | Free-text servings | No row-level source IDs or gram evidence; numerical nutrition accuracy cannot be certified |

The first three rows total **13,588 source foods and 37,026 portions**. Frozen comparison populations overlap and include candidates; they are **not** counts of distinct currently searchable foods. The audit does not check every nutrient field, all recipe nutrition, all provider catalogs, deployment migration status, or patient history.

Evidence files:

- `docs/food-portion-audit/evidence.json`: reproducible results, source identifiers, original portion facts, code hashes, and clearly labeled synthetic probes.
- `docs/food-portion-audit/audit.mjs`: offline runner; no database, network, credentials, patient runtime module, or AI client.
- `docs/usda-import/manifests/*.json`: pinned source URLs, filenames, hashes and release counts. Local ZIPs are in the ignored `.cache/usda-source-downloads/` directory.
- `docs/food-library-cleanup/source-review-records-v3.json` and `bulk-catalog-source-v1.json`: frozen source evidence, not proof of current deployment state.

## Confirmed findings

### F1 — P1: Source quantities disappear in older projections

**Evidence:** `docs/usda-import/reviewed-food-families-v1.json` and `reviewed-food-family-variants-v2.json` retain source `amount` separately, while their portion `label` can be just `oz`. Older SQL snapshot construction copies the descriptor and gram weight, but not the source quantity into the wire label: `supabase/migrations/20261004020000_food_family_variants.sql:105–120` and `20261004060000_food_family_equivalent_variants.sql:23–36`.

The current mobile snapshot shape has no separate source-amount field. `food-nutrition.ts:293–318,336–354` recovers that amount from the label. Thus an older wire label `oz` cannot recover an archived `amount: 4`.

| Source: SR Legacy | Original portion | Lossy label | Deterministic consequence for one selected source portion |
| --- | --- | --- | --- |
| FDC 174030, portion 93663: raw ground beef, 90/10 | 4 oz = 113 g | `oz` | Display looks like 1 oz while scale is 1.13 of the 100 g nutrient basis |
| FDC 171509, portion 88883: raw skinless chicken breast, added solution | 4 oz = 113 g | `oz` | Same four-ounce versus one-ounce discrepancy |
| FDC 171534, portion 88942: grilled skinless chicken breast | 3 oz = 85 g | `oz` | Display looks like 1 oz while nutrition represents the source's 3 oz |

For beef, the original energy is 176 kcal/100 g: `176 × 113/100 = 198.88 kcal`. Normalizing that **source statement** to one of its four ounces gives `198.88/4 = 49.72 kcal`, not 198.88. Using the separate exact weight conversion would give `176 × 28.349523125/100 = 49.8952 kcal`; these are intentionally distinct representations.

The receipt lists 20 projection occurrences covering 18 unique portions. Thirteen unique portions have clear 3-/4-ounce quantity loss. The other five use half-breast or half-container wording; preserve their full source wording rather than assuming a universal “piece” or interpreting the parenthetical package size as another multiplier.

**Important limit:** The newer canonical helper explicitly prepends source amounts and retains evidence (`20261005030000_everyday_food_snapshot_and_constraint_integrity.sql:11–27,54–68`, amended by `20261005050000_everyday_food_portion_evidence.sql:9–14` and `20261005060000_everyday_food_portion_labels_and_apple_pie.sql:9–13`). Its documented rebuilding predicates target `everyday-%` families. The newer path is not accused of losing these quantities. Repository evidence does not establish which older rows remain live.

**Suggested correction:** First perform a food-only, read-only census of legacy-family snapshots by release/FDC/portion ID and helper revision. Where loss is verified, create a reviewed new catalog revision retaining original source quantity, descriptor, grams and evidence. Keep normalized display quantity separate from source quantity. Do not repoint or bulk-recalculate existing diaries. This is a data follow-up, not a reason to block the focused Food Details display fix.

### F2 — P1: Recipe cup-to-weight rules ignore preparation and cut form

**Evidence:** `artifacts/thinnr-mobile/data/ingredient-measures.ts:39–50,72–76,85–104,200–223` and `ingredient-nutrition.ts:111–137`. The name lookup supplies rounded cup weights without a required source record, preparation, or cut-form match.

| Reproduced input name | Current rule | Matching archived physical portion | Difference in implied grams |
| --- | --- | --- | ---: |
| `spinach, cooked` | 1 cup → 1.1 oz = 31.1845 g | Cooked, boiled, drained spinach: 1 cup = 180 g; FDC 168463, portion 83136 | −82.68% |
| `broccoli, cooked` | 1 cup → 3.2 oz = 90.7185 g | Cooked, boiled, drained chopped broccoli: 0.5 cup = 78 g, so 1 cup = 156 g; FDC 169967, portion 85772 | −41.85% |
| `Quinoa, uncooked` | 1 cup → 6.5 oz = 184.2719 g | 1 cup = 170 g; FDC 168874, portion 83924 | +8.40% |
| `almonds, sliced` | 1 cup → 5 oz = 141.7476 g | 1 cup sliced = 92 g; FDC 170567, portion 86864 | +54.07% |
| `almonds, ground` | 1 cup → 5 oz = 141.7476 g | 1 cup ground = 95 g; FDC 170567, portion 86866 | +49.21% |

All source references in this table are SR Legacy 2018-04. These are evidence-backed counterexamples to a universal name-only rule, not claims that every cooked preparation has exactly the same density. A source-qualified food needs its matching portion; a less-specific food needs clarification, not an assumed weight.

The sliced-almond exception is specifically phrase-order sensitive: the table recognizes `sliced almonds`, but the actual matcher falls back to whole-almond weight for `almonds, sliced`. Source almond cups legitimately vary by cut form.

**Nutrition consequence:** Recipe scaling divides by the original ingredient's inferred weight. For a one-cup cooked-spinach baseline, explicitly choosing the source-equivalent `180/28.349523125 = 6.3493 oz` would scale the baseline approximately `180/31.1845 = 5.77×`, although it is the same source physical cup. This concerns the **recipe ingredient bridge**, not the USDA snapshot's documented cup multiplier.

**Suggested correction:** Bind cross-dimension conversions to a cited source portion with food state, cut form, and count unit. Until a match exists, keep original units and same-dimension conversions; do not invent cup weights. Preserve existing ingredient baselines and history. Do not replace every spinach or broccoli density with the cooked example.

### F3 — P1: Negative qualifiers can replace the food identity

**Evidence:** `ingredient-measures.ts:130–136,166–175,204–219`. Name matching picks the last equal-length keyword. It strips selected packing-medium phrases, but not negative qualifiers.

Passing the **exact stored USDA descriptions** ending in `without salt` makes `salt` win. The result is **10.2 oz/cup = 289.1651 g/cup**:

- Cooked spinach, FDC 168463 / portion 83136: source 180 g/cup; inferred weight **60.65% higher**.
- Cooked broccoli, FDC 169967 / portion 85772: source 156 g/cup; **85.36% higher**.
- Cooked lentils, FDC 172421 / portion 90596: source 198 g/cup; **46.04% higher**.

The receipt records the complete stored descriptions and source identifiers. This is a rule failure for those strings; no saved patient recipe was inspected or asserted to contain them.

**Suggested correction:** Resolve the ingredient identity independently of “without,” “no,” and preparation/packing qualifiers. Retain those qualifiers for state/evidence matching, but never allow an excluded ingredient to select the conversion. Add source-backed regression examples for negative qualifiers and cut/state placement.

### F4 — P2: Gram evidence and nutrition multiplier can contradict each other

**Evidence:** `food-nutrition.ts:103–106,143–178,514–535`. Validation checks positive values and `selected.scale = selected.amount × basisMultiplier`. It does **not** check the separate mass relationship when both basis and portion carry gram evidence.

**Synthetic corruption probe, not a stored food:** 100 g nutrient basis; cup declares 200 g; multiplier 1.5; selected amount 1. The actual parser accepts it. Nutrition scales to a **150 g** basis, not the declared **200 g**. The error is −25% against that declared physical portion.

In contrast, setting selected scale to 2 while leaving its multiplier at 1.5 is correctly rejected.

**Suggested correction:** For gram-backed snapshots, independently validate `portion.grams ≈ basis.grams × basisMultiplier`, allowing numerical serialization tolerance. Apply this to source admission/new configurations; do not derive source grams from printed ounces. Preserve source rounding such as 4 oz = 113 g. A volume-based source without gram evidence needs different validation, not a fabricated density.

### F5 — P2: Partial snapshots can log a changed portion with unchanged totals

**Evidence:** `food-nutrition.ts:107–110,627–635`; `FoodLoggingContext.tsx:62–72,151–175`; `lib/food-catalog.ts:218–223`.

**Synthetic incomplete snapshot, not a stored food:** Start with the archived cottage-cheese baseline of 98 kcal/100 g, then deliberately remove the three macro entries and select scale 2. The parser accepts the remaining energy nutrient. `scaledSnapshotMacros` returns null because the full panel is absent. `buildFoodLogEntry` logs quantity 2 but **98 kcal**, not **196 kcal**. Its snapshot branch falls back to the existing root totals without applying the selection scale.

A separate malformed-snapshot probe shows that `parseCatalogFood` drops an invalid optional snapshot yet still returns a legacy loggable food when its root macros are present. This may preserve compatibility, but does not constitute proof of valid physical-portion evidence.

**Suggested correction:** Define an explicit admission rule for incomplete panels. For a new configurable food, either require the full logging panel or use a documented, internally consistent baseline for every available nutrient. Show an explicit unavailable/error state when a reliable baseline cannot be established. Do not silently substitute an unscaled legacy total or rewrite old records.

## Uncertainties and findings that were not confirmed

### Static foods have insufficient source provenance

The 79 static foods in `patient-data.ts:274–376` carry text servings and macros, but not exact source identities or gram evidence. For example, `fd_broccoli` says “Broccoli, steamed,” 1 cup, 31 kcal. Raw broccoli FDC 170379 has a 91 g chopped cup; 34 kcal/100 g gives 30.94 kcal. A different archived cooked, boiled portion has 156 g/cup and 35 kcal/100 g, giving 54.6 kcal.

This resemblance makes the static row a **review candidate**, not proof that it was copied from raw broccoli or that steamed broccoli must equal boiled broccoli. The same limitation applies to “Brussels Sprouts, roasted,” unspecified preparation in ground turkey/sirloin, branded/powder servings, and count-only foods. Suggested action: obtain the original record or label before approving corrections; preserve exact state and edible/drained basis.

### Recipe nutrition and count-unit evidence are separate questions

The static quinoa/lentil recipes contribute per-serving ingredient nutrition, so comparing those numbers directly to a whole dry cup would be a false alarm. Their exact dry cup-weight overrides are compatible with archived source weights, as shown below; this audit does not certify their recipe macro allocation.

`conversionFactorFor('egg', 'egg', 'oz')` and `conversionFactorFor('egg', 'dozen', 'oz')` both return 1.8 in the synthetic count-unit probe. The bridge is not keyed to the count noun. Likewise, a static `broccolini, trimmed` row uses a `bunch`, but there is no cited bunch weight. These are unsupported assumptions requiring source/count-unit evidence, **not** proof that the existing bunch weighs any particular number of ounces.

### No gram value does not automatically mean a bad portion

- All 22,194 FNDDS portions lack the separate numeric `amount` field; quantities reside in `portionDescription`. This is a release-format distinction, not 22,194 lost quantities.
- FNDDS 2705383 / portion 290507 explicitly says “Quantity not specified,” with gramWeight 0. Do not turn that placeholder into a selectable physical measure or classify it as a measured zero-gram serving.
- A source can state nutrition per cup without a weight. `availableNutritionPortions` accepting such a cup is not itself proof of invented density. A claimed **cup-to-weight** equivalence needs additional evidence.
- Unknown ingredient cup-to-weight conversion returns null. Milk is treated as volume-only and also returns null for cup-to-weight. Both are correct.

### Legitimate source rounding and multi-unit portions

- Cottage cheese FDC 172179 / portion 90034 records **4 oz = 113 g**. Exact avoirdupois conversion gives **113.3980925 g**. The 0.3981 g difference is not evidence to rewrite the source.
- The actual mobile snapshot calculation for 8 displayed source ounces selects two archived portions: scale 2.26, representing 226 g, while retaining the original source statement. No double scaling was observed.
- Almond FDC 170567 cups are **143 g whole, 108 g slivered, 95 g ground, and 92 g sliced**. These different gram values are legitimate source portions, not duplicates to average.
- `quinoa, rinsed`: 6 oz = 170.0971 g against uncooked FDC 168874's 170 g cup.
- `dried green lentils, rinsed`: 6.8 oz = 192.7768 g against raw FDC 172420's 192 g cup; the generic source does not prove a cultivar-specific weight, but gives no basis for alleging a dry/cooked error here.
- `strawberries, sliced`: 5.9 oz = 167.2622 g against FDC 167762 / portion 81921's **166 g sliced cup**. Comparing it to the same source's 144 g **whole** cup would be a false positive.
- These three recipe differences fit rounding to about 0.1 oz (half a rounding step is 1.4175 g). Do not impose that tolerance on archived source-to-source field comparisons, which should remain exact.
- The calorie total need not equal `4×protein + 4×carbohydrate + 9×fat` exactly; rounded nutrients and source energy methods make that an unsuitable standalone error detector.

## Privacy, licensing, and change boundaries

- No patient record, saved diary, private recipe, account identifier, or provider payload was sent to an audit model. Static food/recipe declarations were examined separately from adjacent patient/diary sections.
- No provider API or database was called. No credentials were read. The runner uses only local public USDA archives and repository food-only records.
- FatSecret nutrition was not fetched, copied, persisted, or used as audit-model input. Existing access keys do not establish permission for storage, advice, or AI processing; see `docs/fatsecret-evaluation.md`. Any later provider-specific check needs verified permission for its intended use.
- Open Food Facts/branded/personal DTO behavior was considered only through synthetic contract probes. This is not a provider-nutrition audit or a license approval.
- No runtime AI detection, food rewriting, historical migration, or presentation redesign was implemented. The focused Food Details quantity/unit work remains independent.

## Reproduction and verification

From the workspace root:

```sh
node docs/food-portion-audit/audit.mjs > /tmp/food-portion-audit-evidence.json
pnpm --filter @workspace/thinnr-mobile run test:food-portions
pnpm --filter @workspace/thinnr-mobile run test:food-nutrition
node docs/food-portion-audit/render-report.mjs
```

The runner requires Node, the workspace TypeScript dependency, `unzip`, and the three pinned local ZIPs. If an archive is unavailable or its original-byte hash differs, it stops rather than silently trusting a substitute. It extracts into a temporary directory, removes that directory, and writes only a JSON receipt to stdout. The deliberately synthetic probes assert the audited behavior; they are not production food fixtures or a regression suite that claims the defects are fixed.

The separate renderer creates the self-contained `food-portion-audit.html` document from this report. It has no scripts, remote assets, or application dependencies and can also be printed from a browser.

`checkoutCommitAtRun` records the checkout when the runner executed; it intentionally changes after commits. Compare evidence excluding that run metadata field. `codeHashes`, input-file hashes, release identities, and numerical results pin what was actually checked. Source-field or reviewed-macro discrepancies are emitted for inspection and cause a nonzero exit, not a successful verification.

**Results:** Archive hashes/counts passed; frozen source-field comparisons passed; all 184 reviewed core nutrient comparisons passed; both existing mobile suites passed. The latter validate helper behavior, not source correctness across the catalog. In particular, the beef/green-bean fixtures in `verify-food-portions.ts` are not independent evidence for a real food's complete nutrient panel.

No application runtime changed, so no application restart or end-to-end patient journey was needed. Proposed corrections require separate authorization and tests before changing source revisions or user-visible logging behavior.

A static preview capture was attempted but the Expo preview URL returned an HTTP failure. This audit makes no visual/UI verification claim; no runtime repair was attempted as part of this read-only deliverable.