# Find foods without overwhelm

**Status:** Implemented and verified in the existing Expo app.
**Last updated:** 2026-09-08.  
**Implementation target:** One coherent improvement to the existing Expo food-search-to-diary flow.

The user explicitly authorized implementation on 2026-09-08. The requirements below now guide the actual food-search, nutrition and logging changes, including the necessary narrowly scoped database migrations. Publishing and native binary distribution are not part of this request. Runtime acceptance must be established by implementation evidence, not this document alone.

## 1. The patient experience

**Show a few useful choices now; reveal detail only on request.**

Keep THINNR Heritage colors, cream cards, serif headings, existing meal selection, and multi-food basket. No new app, design system, authentication system, or food-data provider.

| State | What the patient sees | What an action does |
| --- | --- | --- |
| Start | Meal selector, one prominent “Search foods” field, at most six Recent foods, and one “Favorites” switch | Favorites replaces Recent; it does not add another list. New patients see “Search for a food to get started. Foods you log will appear here.” |
| Secondary tools | One compact “More ways to add” surface | Opens existing barcode, photo/label and Create Food entry points, plus the labeled Approved-only filter. Returning preserves meal, query and basket. An active filter stays visible and removable. |
| Food search | At most six distinct relevant results total, across eligible shared and private foods | “Show more” adds the next batch of up to six. No infinite scroll, automatic expansion, Most Logged block, or competing Common/Personal/Branded lists. |
| Food row | Familiar name, at most one variation/serving subline, and a separate plus/check control | Row opens details; plus selects the visible configuration; check deselects it. No calorie column or favorite star on the row. |
| Unresolved food | Familiar name and a short “Choose type” subline | Both row and plus open the essential-choice control. Nothing arbitrary enters the basket. |
| Details | Name, selected-variation summary, one amount/unit control, calories/protein/carbs/fat and one “Select food” or “Update selection” primary action | Changes remain a draft until confirmed. Back discards the draft and preserves any previous basket selection. |
| Optional detail | “Change type/preparation,” “Nutrition Facts,” “Source,” and a separate favorite action | Each opens independently. Variation dimensions and units initially expose no more than three choices, with “More options”/“More units” for the rest. |
| Other search intent | Quiet “Search packaged foods” and “Search recipes” links | Opens the explicitly chosen result section instead of interleaving it with basic foods. Search does not require category, brand or source filters first. |
| Basket | One compact selected-items summary and one final “Add foods” action for the chosen meal | Summary expands for review/edit/remove. It is not a second permanently expanded list. |

Recent and Favorites use saved configurations, not newly recalculated catalog defaults. Recents show the latest exact configuration per recognizable food, up to six; older valid foods remain searchable. Favorites can contain deliberately different variations and are paged in small batches. The search field remains prominent in both views.

Keyboard dismissal must not consume the first selection tap. Give the row and control separate accessible names such as “View Ground Beef details,” “Select Ground Beef, [visible type and amount]” and “Deselect Ground Beef, [visible type and amount].” They are sibling targets, not nested pressables that trigger each other. Announce loading/errors, selection changes and changed nutrition without reading an entire nutrient table.

## 2. Build reviewed families, not renamed raw rows

### Identities and review gate

Introduce a reviewed presentation layer over the **existing loggable catalog**:

- **Family:** stable presentation key, familiar name, reviewed aliases, meaningful dimensions and their common-choice order.
- **Variation:** one supported dimension tuple pointing to an exact catalog identity and immutable source revision. For USDA, retain release ID, FDC ID and original source serving/nutrient evidence. A family key is never a logged food ID.
- **Default policy:** an explicitly documented common source-backed option, a clearly labeled generic estimate from one source record, or `choice required`. No implicit raw/cooked state or fat percentage.
- **Equivalence mapping:** reviewed cross-source/legacy aliases can share a result without merging their nutrition. Designate the precise source for a new default; preserve other precise variants and historical snapshots. Text similarity alone never proves equivalence.
- **Approval:** attached to the precise eligible variation and its existing official constraints, not inherited by every member of the family. Do not change official program wording or expand classifications.

The authoring deliverable during implementation is a checked-in reviewed manifest. Every entry must pin its exact source/release, supported tuple, display name, basis, available nutrients, portion evidence, aliases, default rationale and existing approval link where applicable. Validate it against ready releases and loggable eligibility before any narrowly scoped catalog promotion. Missing macros, missing necessary portion evidence or an unsupported tuple cannot be patched with invented facts.

Source import completion is not family review completion. The existing report records 13,588 source foods across three ready releases, not 13,588 patient menu choices. Keep source tables internal/service-role-only and the immutable import untouched.

### Initial family review matrix

These are **dimensions to verify**, not a claim that every combination exists. Only manifest-backed tuples become selectable.

| Family | Relevant distinctions to review | Starting portion rule |
| --- | --- | --- |
| Ground Beef | Lean/fat ratio; raw versus cooked; meaningful preparation | 5 oz when supported; state the exact leanness and preparation, or require the missing choice |
| Chicken Breast | Raw/cooked, skin, preparation | 5 oz edible weight when supported; no bone-in piece-to-weight guess |
| Chicken Thighs | Raw/cooked, skin, preparation | Same evidence-backed protein weight rule |
| Chicken Wings | Skin/meat-only and preparation | 5 oz edible weight; a wing count only with a documented edible portion |
| Eggs | Whole/white and preparation; size-specific portions | Prefer one documented egg, showing its size; do not default every egg to 5 oz |
| Rice | Rice type and dry versus cooked | Prefer a documented cooked portion if a common cooked default is reviewed; never apply cooked volume to dry nutrition |
| Apples | Whole/prepared form and size-dependent counts | Prefer one documented apple with size shown |
| Bananas | Whole/prepared form and edible portion | Prefer one documented banana with size shown; do not count peel as edible weight |
| Yogurt | Plain/flavored, style and fat level when supported | One documented serving; cup/container only when supported |
| Meatballs | Ordinary meat dish versus explicitly meatless; source recipe/composition | Clearly labeled generic-dish estimate if supported; 5 oz weight or documented count as appropriate |
| Ketchup | Generic versus distinct formulated alternatives | A documented tablespoon/serving; Heinz remains an explicit product search, not a renamed generic default |

Keep meatless identity distinct from ordinary meatballs in search and selection. Do not flatten Chicken into one family: Breast, Thighs and Wings remain recognizable separate results.

Existing code contains reviewed wing labels for source IDs including `173630`, `172392` and `172390`. Those are starting evidence only, not approval of this complete family manifest or a chosen default. No new exact IDs, brand panels or markets are invented in this plan. Completing the eleven-family review and binding its exact-ID fixtures is part of implementation, not a follow-up that can be skipped.

Other valid catalog matches remain available as bounded singletons until their equivalence is reviewed. Use conservative, recognizable labels that preserve distinguishing modifiers; never strip “meatless,” “raw,” brand or preparation merely to shorten a name. Keep the full technical description in Source. Unreviewed source-library rows do not enter patient search automatically or become family defaults.

## 3. Rank and page before limiting

### Server pipeline

Extend the current catalog search RPC with a new migration; do not edit previously applied migrations or sort a truncated raw result list into apparent compliance.

1. Normalize case, whitespace, punctuation and common word order. Use reviewed singular/plural forms, shorthand and misspellings. Parse `90% ground beef` and `90/10 beef` into Ground Beef plus **90% lean / 10% fat**. Preserve meaningful negatives and requested modifiers.
2. Resolve intent: ordinary food by default; reviewed brand/product intent for queries such as Heinz ketchup and Core Power; explicit packaged/recipe surface when chosen. Two words alone are not brand intent.
3. Obtain all eligible matching candidates using indexed retrieval, keeping patient-private candidates scoped to the authenticated account. Apply explicit constraints and Approved-only eligibility **before** representative selection and paging.
4. Group reviewed candidates by family and equivalence, with valid unmapped catalog foods as singletons. Private custom foods are not merged with shared foods solely because names match.
5. Rank distinct results lexicographically: valid exact requested product/name and reviewed equivalent aliases, then constrained phrase/token matches, then weaker matches. Incompatible requested types are not substitutes. Personal relevance/recency/favorites and popularity break ties **within** a relevance tier, never outweigh a better exact match.
6. Choose a supported representative for each family using the configuration rules below. Stable result-key tie-breaking makes paging deterministic.
7. Fetch six distinct results plus a one-result lookahead. Return up to six, `hasMore` and an opaque continuation cursor. Each Show more does the same; no raw-row limit precedes family grouping.

Pin cursors to normalized query, intent, Approved filter, ranking/review version and account-private ranking context. Capture a ranking watermark/version so changed usage cannot reorder pages silently. Reject mismatched/stale cursors with a restart action rather than skipping or duplicating results.

Extend the existing API/OpenAPI contract with ordered results, result keys, configured-variation metadata or `choice required`, and continuation state. Regenerate clients; do not hand-edit generated files. Retain a compatibility response/default for existing consumers until they are migrated.

Local offline candidates need the same normalization, grouping keys and relevance tiers. Do not prepend local arrays to remote results or cap each source separately. Once an online ordered page arrives it is authoritative; cached results are clearly labeled while unavailable. Never show another account's cached candidates. Approved-only must operate on eligible variations at the server, not merely remove unapproved items after the limit.

### Packaged and recipe intent

- A generic search excludes packaged-product flooding, including historical brand-specific USDA records; source type does not prove generic identity.
- Explicit branded intent uses the existing Open Food Facts pathway even if generic local matches already fill six slots. Return genuinely matching eligible products, not weak generic substitutes.
- Filter for complete loggable facts and deduplicate by canonical barcode/product identity before paging. Prefer verified US-market metadata **among equally relevant exact products**; unknown market stays unknown and never gains a US label.
- Bound upstream requests. Retain a query-scoped ordered candidate window/continuation, rather than treating the current small upstream cache slice as the entire search universe. If the existing provider cannot supply more eligible results, say so and offer barcode/label scanning.
- No exact eligible product: “No matching packaged food found. Try scanning its barcode or label.” Provider failure is a different retryable state, not a claim of no match. Guided-demo/auth restrictions remain explicit rather than fabricated live results.
- Recipes open separately and have their own six-at-a-time results and exact identities. Keep their existing details/ingredient behavior; do not redesign recipe units. Selecting a recipe participates in the same basket/final meal action rather than unexpectedly submitting a partial meal.

### Response and navigation safety

Keep the current 300 ms debounce. Key every request and cursor by account epoch, normalized query, intent and filter; abort superseded requests and also check the key/generation after every await. Disable duplicate Show more requests; old pages cannot append to a new query. Dedupe by stable result key as a defensive check, not the grouping algorithm.

Store the search session above detail navigation: query, active section, filter, meal/date, loaded pages and scroll anchor. Back restores all of it, including scroll position after layout. Switching accounts clears in-memory search, basket and drafts; private persistent preferences remain accessible only to their owner. Loading, initial no-match, incremental loading, partial cached results, error and Retry each have distinct calm states.

## 4. Exact configurations, units and nutrients

### Choice precedence

For an opened existing basket item, begin with **its own snapshot**, not the current catalog. Otherwise:

1. Honor the explicit query's supported type constraints.
2. Restore the account's last explicitly confirmed compatible variation and amount.
3. Use a reviewed, visibly labeled common option or generic estimate.
4. If no valid default exists, ask only for the essential missing choice.

A query asking for 90/10 must not restore a remembered 80/20 choice. An explicit request excluded by Approved-only returns an honest no-eligible-match/choice state, not silent substitution. Existing basket items survive filter changes.

“Change type/preparation” exposes at most three common values per relevant dimension, then More options. Filter subsequent dimensions by available tuples. Preserve compatible choices; never silently reset an incompatible dimension to another record. Changing variation updates calories and every available nutrient from that variation's baseline, and makes any necessary portion change visible before confirmation.

### Portion contract

Each supported unit stores its identity, label, dimension, source portion reference and exact conversion to the variation's nutrition basis:

- Weight: grams/ounces using the established `28.349523125 g/oz`, only for appropriate documented weight bases.
- Count: egg, piece, wing, etc. only from a size/edible-weight documented portion.
- Volume: cup/tablespoon/fluid ounce only from a documented volume basis or same-food portion-to-weight evidence.
- Bottle/container: only when its volume or serving count is explicitly documented; package size is not automatically one serving.

Offer at most three immediately useful units; More units can expose other supported choices. Do not infer `1 mL = 1 g`, universal liquid weights, cooked/raw conversion, or arbitrary package counts. Legacy free-text servings retain their current multiplier behavior without guessed conversions.

Keep the selected amount exact internally. Unit switching preserves the physical amount when a supported conversion exists; its displayed precision must not imply a different logged amount. Round only formatting, never the baseline. Compute `scale = selected amount in basis / original basis amount`; every nutrient is `original nutrient × scale`. Repeated edits and unit round trips must equal direct computation.

### Snapshot contract through the whole system

Add a versioned optional food-nutrition snapshot that travels through catalog DTOs, mobile items, saved-food/favorite configurations, queue payloads, server validation/storage, diary hydration, copy, edits, removal and Undo:

- precise catalog/source identity and immutable revision/release;
- original serving basis and supported portion evidence;
- full unrounded baseline nutrient values with nutrient identity and units;
- selected variation summary, amount/unit and scale;
- provenance/quality kind: generic source, generic-dish estimate, exact identified product or personal/label data.

One nutrient definition resolves to one source amount by a documented source-specific rule; do not sum duplicate nutrient IDs, mix energy derivations, or fill missing values from a different record. The existing four macro fields remain compatible derived display/log fields.

Missing extended nutrients are absent/null, never synthesized zeroes. Preserve an actual `0`. If no full panel is supplied, say “Additional nutrients not provided.” When some are available, show those values and explain that unlisted nutrients were not provided. Do not claim a panel is complete.

Existing label parsing already carries fiber, sugar and sodium before conversion drops them. Preserve these without adding new photo/coach behavior. Extend existing barcode normalization/cache/DTO conversion to carry only facts actually supplied; do not fabricate extended values from its currently macro-only contract.

For legacy entries without a baseline, retain their original recorded snapshot and existing multiplier semantics; if capturing a baseline on first edit, capture only those original stored values. Never fetch a current catalog panel to “repair” historical nutrition. Catalog refreshes create new revisions for future selections, not a recalculation of saved foods or diary history. Personal corrections, if later exposed, affect a private version only; this plan adds no shared-fact editing UI.

### Optional Nutrition Facts and Source

Nutrition Facts shows all available relevant fats (including saturated, trans, mono/polyunsaturated), cholesterol, sodium, carbohydrate, fiber, total/added sugars, protein and vitamins/minerals. Source is a separate expansion containing the original description, provider/release/record identity, serving evidence and estimate/product qualification.

Use the [FDA Daily Value reference guide](https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels), checked during planning on 2026-09-08, with the applicable general adult/age-4+ reference and clear “general reference, not your personal THINNR target” wording. Pin the reference/version and full nutrient-unit mapping in implementation. Examples: total fat 78 g, saturated fat 20 g, cholesterol 300 mg, sodium 2,300 mg, carbohydrate 275 g, fiber 28 g, added sugars 50 g, calcium 1,300 mg, iron 18 mg, potassium 4,700 mg and vitamin D 20 mcg.

Calculate `%DV = valid amount / applicable reference × 100` only when units and nutrient form agree. Vitamin A RAE, folate DFE, niacin NE and vitamin E forms require matching evidence; no guessed IU/equivalent conversion. Total sugars and trans fat have no %DV; mono/polyunsaturated fats have no listed DV in this reference. Show protein grams, not an automatic grams/50 calculation: protein %DV needs the applicable corrected-protein evidence/rules. See the [FDA explanation](https://www.fda.gov/food/nutrition-facts-label/lows-and-highs-percent-daily-value-nutrition-facts-label) and [21 CFR 101.9(c)(7)](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101/subpart-A/section-101.9).

## 5. Favorites, basket and honest saves

Use the existing authenticated patient-data/offline rail for exact per-account configurations; extend it rather than creating another store or auth scheme. Private preference/favorite records need the same owner checks, account-epoch protection, offline serialization, reconciliation, privacy export/deletion and patient-identity write barrier as other patient-owned data. Keep demo state separate.

- Remember variation and amount only on an explicit confirmation/selection, not on opening details or experimenting then pressing Back.
- Favorite action explicitly saves the shown exact configuration, independently of basket confirmation. Removing a favorite does not remove a basket item or alter diary history. Legacy favorite IDs still resolve without invented type/portion history.
- Give each basket item a stable selection key separate from family/source identity. Editing names the selection being replaced; selecting a different variation intentionally creates a distinct item. If an edit reaches an already-selected identical configuration, show the existing choice instead of silently duplicating or overwriting it.
- A row's check reflects its visible configured variation. Other selected variations remain visible in the basket summary, not hidden behind an ambiguous family-wide check.
- Final Add dismisses the keyboard, synchronously acquires the submission lock, and captures account, meal, entry IDs and immutable snapshots. Persist all chosen foods as individual entries through the existing compound mutation/idempotency contract.
- Expose explicit outcomes for this caller: locally saved demo, queued real-account submission, server-confirmed, or rejected. A nonempty returned entry array is **not** proof of server confirmation.
- Rejection before acceptance retains the editable basket and shows Retry. Do not swallow an external selection/promotion failure and log an unverified fallback. Previously saved valid snapshots stay usable offline; an unresolved new external product waits for verification.
- Queued acceptance shows “Pending sync”/“Saved on this device; waiting to sync,” never “Saved to your account.” Retain a recoverable submitted-basket snapshot associated with the existing queue ID until acknowledgment. Navigation may continue; revisiting shows the pending submission without enabling a second Add.
- Later server rejection restores that same selection to review/retry, reconciled with the failed queue item. Retry reuses its existing operation/entry identities, not a fresh batch. An acknowledgment releases the retained submission snapshot.
- Removal and Undo preserve the exact entry snapshots. Undo while pending must update/cancel through the same ordered queue so a delayed create cannot resurrect a removed entry.

This is a narrow extension for this search-to-save path, not a redesign of every patient mutation or a separate diary incident repair.

## 6. Implementation sequence and proof

All work below is **planned, not executed**. Keep it one deliverable; a working screen without its persistence contract, or an API without its patient UI, is incomplete.

| Step | Work and completion gate |
| --- | --- |
| 1. Fix the small-choice flow | Use section 1 as the screen/state contract. Retain existing visual language; no separate design exploration or new artifact. |
| 2. Review the eleven families | Build the exact-source manifest and supported tuples; verify ready/loggable eligibility, defaults, aliases, portions and per-variation approvals. An unreviewed family is not “done.” |
| 3. Rank families and separate intent | New SQL migration + ordered/paged API. Prove exact winners at limit 1 and grouping at limit 6 before wiring the UI. |
| 4. Carry snapshots losslessly | Implement/version nutrients, portions, source identities and private configurations across every serializer and queue seam. Add backward-compatible schema before the new client consumes it. |
| 5. Connect search/details/basket | Bounded lists, compact dimensions/units, optional panels, favorite action, navigation restoration, and explicit pending/rejected behavior. No intermediate promotion/build/publish hidden in planning. |
| 6. Verify the complete path | One coherent focused database/API/mobile regression pass, then one phone-width interaction/visual pass on the actual Expo artifact. Report failures and blockers honestly. No broad native-release matrix or binary build. |

### Golden search corpus

Run every row at `limit=1` and `limit=6`, plus continuation where more results exist. Fixtures must pin expected catalog ID, source/release/revision and portion basis after review, not just assert a pleasant label.

| Query | Expected result/selection |
| --- | --- |
| `ground beef` | One Ground Beef family; remembered choice or visibly labeled reviewed default; essential chooser if neither exists |
| `90% ground beef` | Same family with supported 90%-lean choice; conflicting remembered leanness cannot win |
| `90/10 beef` | Same constrained outcome and exact source as equivalent 90% wording under the same preparation preference |
| `chicken` | Meaningful cuts, with reviewed stable order Breast, Thighs, Wings where eligible; no giant Chicken default or variant flood |
| `chicken wings` | Wings is first even with competing raw descriptions, recency/popularity and cross-source duplicates |
| `apple` | Apples family via reviewed singular alias; an apple-containing dish cannot beat the exact fruit |
| `meatballs` | Ordinary meatballs first; meatless variants cannot displace a valid ordinary exact match |
| `meatless meatballs` | Supported meatless result or honest no match; never ordinary meatballs as an unannounced substitute |
| `Heinz ketchup` | Eligible requested Heinz product first through packaged intent, or honest branded no match/scanning; not generic ketchup presented as Heinz |
| `Core Power` | Exact product-family matches with actual labels/panels, or honest no match/scanning; no invented flavor, bottle size or US-market status |

Add direct queries for Eggs, Rice, Bananas, Yogurt and Ketchup so the other reviewed families are proven too. Include punctuation/order/plural cases, reviewed typos and negative controls such as “apple pie” and an unsupported beef ratio.

### Regression acceptance matrix

| Layer | Required assertions |
| --- | --- |
| Real local PostgreSQL + API fixtures | Many raw rows in one family cannot consume all six slots; exact match survives limit 1; approved variant chosen before limit; cross-source duplicates grouped without mixing nutrients; deterministic pages; no upstream fallback merely from two-word generic queries; explicit product search works despite full local results; honest provider failure/no match; source/library permissions and owner-private reads |
| Nutrition/contract round trips | Supported/unsupported conversions; appropriate 5 oz versus egg/piece/bottle defaults; zero versus missing; full-panel scaling from original precision; no incompatible nutrient-form DV; macro/extended/source/portion snapshots survive catalog, label/barcode, favorite, saved food, queue, database and hydration |
| Mobile screen/context tests | Default/remembered/query precedence; more choices/units only on request; favorite exact amount/removal; account isolation; row/plus/check separation; edit replaces rather than duplicates; Back cancels; two variations coexist; basket survives query, paging and navigation |
| Save/history tests | Rejected save retains basket; late rejection recovers original submission; pending is not confirmed; repeated Add/lost response/retry do not duplicate; reload retains source facts; later portion edit uses own baseline; legacy custom foods/entries remain usable; copy/remove/Undo preserve extended snapshots, including pending queue ordering |
| Async tests with held responses | Old query/account/intent/filter responses and Show more pages are ignored; duplicate page requests prevented; error Retry stays in current session; scroll/query/meal restored |
| One focused Expo pass | Identify the actual Expo artifact by its post-sign-in bottom tabs, not the similar operations website. At roughly 390–393 px width, cover start/empty state, keyboard, six results/Show more, constrained beef selection, compact details, units/panels, favorite, second selection/edit/deselect, final save/diary and a staged retry. Capture visible layout plus accessible control behavior. Browser-emulated keyboard checks are not proof of an iOS native keyboard. |

### Existing code seams to extend

Paths below were located/read during planning; they identify integration points, not files changed by this document.

- Search/detail: `artifacts/thinnr-mobile/app/log-food.tsx`, `app/food/[id].tsx`, `hooks/useFoodCatalogSearch.ts`, `hooks/useLoggableItems.ts`, `lib/food-catalog.ts`, `context/FoodLoggingContext.tsx`.
- Patient snapshots/preferences: `artifacts/thinnr-mobile/data/patient-data.ts`, `context/PatientContext.tsx`, `context/PatientAccountContext.tsx`, `lib/patient-data-api.ts`, `lib/patient-write-queue.ts`, `data/diary-entry-state.ts`, `lib/label-food.ts`, `lib/barcode-food.ts`, `app/(patient)/library.tsx`.
- API/contracts: `artifacts/api-server/src/catalog/store.ts`, `src/catalog/presentation.ts`, `src/catalog/usda-seed.ts`, `src/routes/catalog.ts`, `src/routes/patient-data.ts`, and `lib/api-spec/openapi.yaml`; regenerate existing API client/zod outputs.
- SQL baseline: `supabase/migrations/20260925000000_shared_food_catalog.sql` and its later `20260925130000_add_reviewed_chicken_wing_aliases.sql`. The later definition already ranks reviewed aliases before a raw-row limit; it still lacks family-before-limit grouping.
- Immutable source evidence: `docs/usda-import/README.md`, `docs/usda-import/live-verification.json`, manifests/receipts, and `supabase/migrations/20261003000000_usda_source_library.sql`. No re-import or rewrite.
- Extend focused coverage in `artifacts/api-server/src/routes/catalog.test.ts` and source SQL tests, plus mobile `scripts/verify-food-catalog.ts`, `verify-approved-foods.ts`, `verify-usda-essentials.ts`, `verify-library-sync.ts`, `verify-diary-edit.ts`, `verify-diary-copy.ts`, `verify-diary-undo.ts`, `verify-live-diary.ts`, `verify-offline-queue.ts`, `verify-barcode-scan.ts` and `verify-label-scan.ts`. Add a focused family-search/snapshot suite and register it using the existing validation mechanism, not duplicate service workflows.

### Current evidence, blockers and boundaries

**Confirmed by read-only review:** search currently requests 30 results and merges source groups; SQL limits raw rows; current details lack family controls/full-panel display; several conversion and server hydration seams only retain macros. Current real-account `commitQueued` accepts a pending write, so `copyEntriesWithExtras` returning rows cannot establish server acknowledgment.

**Not verified here:** live family coverage, exact eleven-family source mappings, live brand availability/market metadata, current runtime health, new snapshot persistence, or the completed visual/save journey. These are future acceptance gates, not failures invented from inspection. If an existing runtime/save blocker prevents those checks during implementation, document its symptoms and blocked acceptance; do not silently fix unrelated systems or report an untested journey complete.

**Explicit exclusions:** another bulk USDA import; automatic exposure of raw source rows; USDA Branded bulk download or new provider; comprehensive international/restaurant search; recipe ingredient-unit work; structured Create Food redesign; new coach/photo AI behavior; staff food tools; broader Approved classifications or program wording changes; separate runtime/diary incident repair; resurrected archived drafts; publishing or native binaries. Existing out-of-scope drafts remain separate. This plan does not create duplicate follow-up tasks.