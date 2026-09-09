# Food picker and quarter-catalog verification

## Applied coverage

| Measure | Before | After |
| --- | ---: | ---: |
| Immutable USDA archive records | 13,588 | 13,588 |
| Catalog rows | 5,290 | 5,290 |
| Eligible basic-search records | 5,278 | 5,278 |
| Reviewed source-specific records | 157 | 1,320 |
| Distinct active reviewed food families | 112 | 713 |
| Additional source variations beyond one per family | 45 | 607 |
| Remaining eligible singletons | 5,121 | 3,958 |
| Reviewed share of the frozen denominator | 2.97% | 25.01% |

The original application added 1,163 existing source records: 603 new families
and 156 additional records attached to 85 existing families. A later explicit
reconciliation folded two duplicate bread/pasta groups into the original
families, retaining all three moved source variations. The final arrangement is
601 new families and 159 additional records attached to 87 original families:
688 represented families in total, with 25 prior families not extended.
No archive reimport, invented nutrition, denominator reduction, or family-wide
approval was used.

Of the 3,958 candidates not added, 2,037 passed the current mapping rules but were
not selected after reaching the target or applying common-food priorities.
The other 1,921 have explicit batch-exclusion reasons, including manufacturer
identities, specialized foods, out-of-scope categories, identity boundaries and
source portions the mobile contract cannot safely represent. These records were
not deleted or removed from the frozen eligibility denominator. There is no
coverage shortfall and no unclassified decision in this batch.

See `bulk-catalog-report-v1.json` for category counts, decisions and examples.

## Source and data preservation

- **Before application:** all 1,163 proposed snapshots passed the actual mobile
  parser, calculator, serving formatter and fresh-default selector. The gate
  checked 2,222 original portions, 4,516 displayed units and 33 documented liquid
  defaults, with zero failures.
- **After application:** all 1,163 persisted snapshots passed the same source
  contract, covering 95,890 literal nutrient values, 26,230 literal zeros and
  2,222 source portions. No reviewed source nutrient amount was missing; separate
  missing-value fixtures remain synthetic rather than being claimed as observed
  source population evidence.
- The application receipt verifies that the archive, previous variants and
  every non-candidate catalog row were unchanged. Original family records were
  unchanged by the bulk migration.
- The later search-ranking repair intentionally appended broad aliases. An
  additional check confirmed that all 112 original names/default source IDs
  and their existing variant-order slots remained unchanged.
- A source-verified singleton correction changed the Alfalfa Sprouts display
  name and aliases, not its original USDA name, source values, eligibility or
  singleton status. It did not increase the reviewed-record count.
- A later Puffed Wheat singleton correction prioritizes the exact generic
  identity over a manufacturer-specific result without changing its source
  facts or counting it as another reviewed record.
- Whole-Wheat Bread and Cooked Pasta had normalized-name overlaps with original
  families. Their three source records were appended to the existing families,
  preserving original defaults and slots. A generic redirect preserves old
  family links; the explicit reconciliation overlay retains the historical
  manifest and proves each moved source/revision is still available.
- Supabase security-advisor warning counts remained unchanged. One informational
  RLS-without-policy notice was added for the intentionally server-only redirect
  table: RLS is enabled, anon/authenticated have no SELECT, and service-role
  access is retained. No permissive policy was added to hide the notice.

Evidence:

- `bulk-serving-preflight-v1.json`
- `bulk-live-source-verification-v1.json`
- `quarter-catalog-reconciliation.json`
- `bulk-post-ranking-preservation-v1.json`
- `bulk-family-reconciliation-v1.json`
- `bulk-family-reconciliation-receipt-v1.json`
- `bulk-security-advisories-v1.json`

## Picker and logging checks

Focused screen/data checks cover:

- Roasted → Fried → Roasted without the incidental coating trap.
- Genuine incompatible types, confirmation and cancellation.
- Fresh editable 5 oz defaults, with source-supported volume for liquids.
- One/two wings or drumettes; whole/quarter/fractional cups.
- Individual beans normalized from the original ten-bean/55 g source portion,
  with the original source measure visible under More units.
- Same-unit no-op, exact ounce/gram conversion, and preserved preparation-change
  weight or equivalent household count.
- Original source quantities greater than one, dimensional qualifiers and the
  literal cottage-cheese statement **4 oz = 113 g**.
- Pending numeric input driving the displayed amount, macro preview, expanded
  nutrition facts, favorite identity and final action without requiring blur.
- Pending 7 oz → grams preserving exactly 198.446661875 g; pending 7 oz surviving
  preparation changes. Invalid amounts block unit/type/favorite/save actions.
- Raw decimal text remains editable; deliberate fractional amounts are not
  snapped to a different quantity.
- Quick-select deselection, remembered configurations, basket identity,
  selected-total snapshots and historical quantities.
- Historical-family snapshots reopening against canonical returned variants,
  and a remembered 7 oz serving restoring through `familyKeyAliases` without
  changing source, snapshot or configuration ID. Unrelated families cannot
  claim the remembered configuration.

The focused suites used were `test:food-detail`, `test:food-portions`,
`test:food-catalog`, `test:food-nutrition`, mobile typechecking and the affected
API catalog route/manifest suites. Later UI-only corrections received the
targeted no-blur screen regressions and typechecking, not a second browser pass.

### One phone-width browser pass

The pass used the actual Expo domain at 393 × 852, not the operations web app.
It verified the preparation reversal; 5 oz; one wing; two drumettes; same-unit
no-op; favorite/save behavior; invalid input blocking; quick-select deselection;
basket reopen/cancel; quarter-cup steps; unblurred half-cup selection; and logging
to the intended meal/day.

The diary retained **2 drumettes / 111 calories** and **½ cup Green Beans /
16 calories**, with their matching macros, after reload. Demo authentication is
session-only, so the tester re-entered the same guided demo before inspecting
the already-persisted entries. No foods were logged twice, no real account was
used, and authentication behavior was not changed.

## Search acceptance

The original 334-case corpus is retained. The expanded corpus adds exact names
and bounded aliases for every new family, supported/unsupported variation
checks, and explicit chocolate-milk, cereal, sprout, condensed/evaporated milk
and meat-substitute identity boundaries.

The complete run caught modifier words inside literal identities, such as
Frozen Yogurt and Dry White Cheese. The repair recognizes the longest bounded
food identity first and applies constraints to the remaining words. A true
variant request such as raw Chicken Wings still selects the raw source, and
unsupported stacked constraints still return no substituted food. Hyphenated
names and singular/plural aliases use the same normalization. Public cursor
ranking version `food-families-v7` invalidates cursors from the prior ordering.
Contained family names are admitted only when every remaining token is a
recognized constraint, preventing Apples in Apple Pie results and Wheat/Rice
from suppressing the corresponding puffed cereals. This gate precedes singleton
suppression.

Public HTTP checks confirm six-result pages, 12 unique identities across two
pages, and Chicken Breast/Thighs/Wings leading a broad chicken search. Exact
source winners and Approved-only checks are part of the shared corpus.

The authoritative full-corpus outcome is
`bulk-live-search-verification-v1.json`: **1,569 cases / 1,560 distinct queries,
zero failures**. Each case checks bounded unique identities and limit-one
stability; exact cases pin source/revision and prepared cases check every
returned row against available tuples. Two six-result pages had no skipped or
repeated identities. The final search loop took 409 seconds.
SQL corpus checks alone do not establish public HTTP cursor behavior.
The separate HTTP paging report is `bulk-http-pagination-v1.json`.

### Search performance

The larger population exposed planner fan-out: lateral variant lookup ran for
hundreds of families before joining the few matching families. Wide singleton
aggregation also spilled nutrition-bearing rows to temporary storage.

The forward performance repairs preserve literal-token safety and compare
before/after results transactionally. These measurements were taken at the
performance-repair stage, before the final literal-identity boundary repair:

- `raw Ground Turkey` core execution: **621.647 ms → 51.581 ms**, with temporary
  blocks read dropping from **103,704 → 0**.
- Five-case verifier-shaped batch (seven results, one-result winner and query
  resolution): **20,090 ms → 797 ms**, with byte-for-byte equal output.
- Twenty-case exact-name, raw and cooked verifier batches subsequently completed
  in **2,096 ms**, **2,053 ms** and **1,841 ms** respectively.

These are specific measured query/batch improvements, not a claim that every
patient request became 25 times faster. Management HTTP timings include network
latency. Source records, defaults, aliases, approvals and nutrition were not
changed by the performance repairs.

The final boundary-aware HTTP checks are recorded in
`bulk-http-pagination-v1.json`: the reconciled exact-family probes completed in
280/542 ms and the two broad chicken pages in 1,391/1,225 ms. The same checks
proved legacy aliases survive API presentation and old family URLs expose all
canonical variants. These are observed samples, not latency guarantees.

## Boundaries

No publishing or native distribution was performed. The legacy verification
fleet was not restarted. Existing snapshots, account boundaries, custom-food
edit/delete/Undo, offline writes and the official Approved Foods wording were
not replaced or redesigned.

For regeneration and guarded application, see `bulk-catalog-runbook-v1.md`.
This applied batch is immutable evidence; another expansion needs a newly
versioned candidate inventory rather than refreshing this baseline in place.