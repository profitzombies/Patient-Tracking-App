# Everyday food discovery cleanup

This is a presentation and matching layer over the existing private USDA archive,
not a replacement import and not a claim that every archived food is selectable.

## Reconciled coverage

| Population | Before | After |
| --- | ---: | ---: |
| Archived source records | 13,588 | 13,588 |
| Catalog records, including one packaged record | 5,288 | 5,290 |
| Reviewed food families | 11 | 112 |
| Exact family variations with nutrition snapshots | 39 | 157 |
| Search aliases | 364 | 608 |

The expansion reviews **101 distinct identities**, including the 100-food,
ten-category checklist plus Apple Pie. They have **118 exact source-backed
variations**. Source variations do not count as additional identities.

The complete catalog is classified as:

- **157 reviewed-family records** with familiar family names and exact variations.
- **5,121 conservative singleton records**, eligible for all-word matching but
  not represented as individually reviewed familiar-name mappings.
- **12 excluded records**: packaged or specialized/institutional records excluded
  from basic food search. Packaged search is a separate intentional mode.
- **8,299 archived-only source records** have no catalog link. They are not
  exposed as selectable merely because the raw archive contains them.

Of 5,289 indexed source records, 5,278 are eligible for grouped basic search.
The remaining catalog record is not USDA sourced. Archived and catalog
populations must therefore not be added together as a patient-food count.

`catalog-audit.json` is the direct read-only live reconciliation.
`source-review-records-v3.json` contains the per-record canonical descriptions,
aliases, dimensions, and original portion evidence for the expansion.
`everyday-food-identities-v3.json` pins the original ten-category checklist.
Uncertain singleton names remain conservative rather than receiving guessed
food identities.

## Measured checks

- `search-verification.json`: **334 cases / 332 distinct queries**, zero failures.
  Every case has assertions. Exact names pin family, source and revision;
  raw/cooked requests use the actual available source tuples; unsupported
  constraints remain empty. Paging checks two real six-row pages plus overlapping
  lookahead/bridge windows, not an empty second page.
  Broad queries prioritize familiar families; stacked constraints are checked in
  both word orders.
- `snapshot-contract-verification.json`: the real mobile parser and calculator
  checked **118 new snapshots, 12,300 supplied nutrient values, and 345 source
  portions** against the immutable records. Literal zeros remain zeros.
  These SR records contain no nutrient rows with missing amounts; an explicitly
  synthetic partial-panel fixture separately checks that omitted nutrients are
  not created as zero.
- API route and manifest tests cover source projection, explicit packaged intent,
  account-bound query resolution, correction/suggestion transport, and cursors.
- Mobile catalog/detail/nutrition/portion checks cover filter-aware remembered
  choices, rejected and queued direct adds, duplicate-tap protection, singleton
  lookup persistence, original baselines, and historical portions.
- Focused library sync, offline queue, diary edit/delete/Undo, and custom-food
  Undo checks preserve existing data behavior. No legacy workflow fleet was run.
- The actual 393-pixel Expo journey verified identical ordering between Library
  and Add Food, details without hidden adds, Library-to-Lunch saving of 100 g
  Broccoli at 34 calories, and batch-to-Dinner saving of 5 oz cooked 90/10 Ground
  Beef at 326 calories with no duplicate. Demo saves stay local; real accounts
  retain protected promotion and account-scoped persistence.

Source portions retain their recorded quantities, even when those differ from
an independent unit conversion. For example, the archived cottage-cheese records
say **4 oz = 113 g**. The standard ounce option independently uses the exact
avoirdupois conversion; the USDA source portion is not silently recalculated.

## Reproduce

Run from the workspace root. Supply the confirmed existing Supabase project
reference to the read-only live scripts; credentials remain in the environment.

```sh
node artifacts/api-server/scripts/everyday-foods/build-corpus.mjs /tmp/everyday-corpus.json
node artifacts/api-server/scripts/everyday-foods/audit-catalog.mjs --project <confirmed-project-ref>
node artifacts/api-server/scripts/everyday-foods/verify-source-review.mjs --project <confirmed-project-ref>
node artifacts/api-server/scripts/everyday-foods/verify-search-corpus.mjs --project <confirmed-project-ref>
pnpm --filter @workspace/thinnr-mobile exec tsx scripts/verify-everyday-snapshot-contracts.ts --project <confirmed-project-ref>
pnpm --filter @workspace/thinnr-mobile run test:food-catalog
pnpm --filter @workspace/thinnr-mobile run test:food-detail
pnpm --filter @workspace/thinnr-mobile run test:food-nutrition
pnpm --filter @workspace/thinnr-mobile run test:food-portions
```

All catalog migrations are forward-only. They do not replace the source archive,
average nutrition, grant family-wide approval, or alter existing patient diary
records. Grouping and constraints run before ranking and pagination; both mobile
entry points consume the same ordered results and remembered-choice overlay.