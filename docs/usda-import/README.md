# USDA source library

This is the **data foundation**, not a replacement of patient-facing food search.
The existing shared catalog, barcode cache, saved foods, diary, and all patient
records are intentionally outside the importer's write scope.

## Selected releases

| Source | Version | Actual food records | Nutrient entries | Portion entries |
| --- | --- | ---: | ---: | ---: |
| SR Legacy | April 2018 (final release) | 7,793 | 644,125 | 14,449 |
| FNDDS | 2021–2023, October 2024 distribution | 5,432 | 353,015 | 22,194 |
| Foundation Foods | April 2026 | 363 | 15,193 | 383 |
| **Total** | | **13,588** | **1,012,333** | **37,026** |

These are source records, **not 13,588 distinct patient-facing food choices**.
Descriptions/foods can overlap across sources. SR Legacy also includes historical
brand-specific entries; its source type is not proof that a record is a generic food.
The large USDA Branded Foods release is deliberately not included.

The uploaded Foundation file was byte-for-byte equal to the official ZIP's JSON.
It contains 395 array entries, of which **32 are literal null placeholders**.
Their zero-based positions are preserved in the release manifest. They are not
foods and do not become empty or zero-calorie catalog entries.

FNDDS includes one food record without nutrient amounts, with an explanatory
source footnote. It is preserved as source data, not silently removed and not
eligible for logging merely because it matches a search.

## Preservation and access

- `public.usda_source_releases` holds immutable file manifests and loading/ready
  status. Manifests include official URLs, source versions, SHA-256 of the original
  JSON bytes, counts, nutrient coverage, and null-placeholder evidence.
- `public.usda_source_foods` holds every complete original food object as JSONB,
  scoped by release and FDC ID. Every nutrient, portion, derivation, nested input
  food, conversion factor, historical flag, and unknown source field is retained.
- `public.usda_source_nutrients` and `public.usda_source_portions` are
  security-invoker views over **ready releases only**. They retain array order and
  raw entries alongside convenient fields.
- All source objects are internal/service-role-only; no patient/anonymous reads,
  no public upload endpoint, and no changes to current search.
- Missing nutrient amounts remain missing (NULL in views). Numeric zero stays
  zero. No nutrient averaging, density assumptions, weight/volume substitution,
  or invented serving weights occurs.

The source library is not automatically promoted into `food_catalog_items`.
That existing catalog is a reviewed, loggable-food layer, not a full USDA archive.

## Reproduce or resume

All scripts are dependency-free Node modules in
`artifacts/api-server/scripts/usda-source/`.

Official downloads are pinned in `datasets.mjs`; small reviewed manifests are
under `manifests/`. ZIPs are cached locally in the git-ignored
`.cache/usda-source-downloads/`. Large vendor data is never bundled into the app
or checked into git by this importer. USDA publishes these datasets at:

<https://fdc.nal.usda.gov/download-datasets>

1. Download the relevant original ZIP from the pinned URL. Extract its JSON to
   an ignored local directory. Do not edit or reformat it: the manifest checks
   the exact original file bytes.
2. Inspect/validate without any database connection:

   ```sh
   node artifacts/api-server/scripts/usda-source/import.mjs \
     --dataset sr-legacy-2018-04 \
     --file /path/to/FoodData_Central_sr_legacy_food_json_2018-04.json \
     --manifest docs/usda-import/manifests/sr-legacy-2018-04.json
   ```

   Other dataset IDs: `fndds-2021-2023`, `foundation-2026-04`.

3. Apply `supabase/migrations/20261003000000_usda_source_library.sql` **once**
   through Supabase's migration mechanism. It is a schema migration, not a
   generated bulk data migration. Do not replay it if it is already applied.
4. After reviewing the manifest, add `--apply --project <confirmed-project-ref>`
   and optionally `--report /path/to/receipt.json` to the same command.
   The command uses existing `SUPABASE_URL` and `SUPABASE_ACCESS_TOKEN` secrets
   at runtime. Never put credentials into arguments, documentation, or logs.

Apply re-inspects the complete file before connecting, checks the explicit
project against the configured project, streams batches bounded to 650 KB of
food JSON, and caps the final HTTP request at 2.4 MB. Requests are paced; transient
failures retry with bounded attempts, respecting `Retry-After` (or a one-minute
cooldown when a rate-limit response omits it). Run releases sequentially to avoid
sharing the management API's rate budget. Rerun the same reviewed command to
resume a partial import.

Each batch is transactional. Existing identical records are verified without
being updated; conflicting content rolls back the whole batch. The release only
becomes ready after the original file hash and all food/nutrient/portion totals
pass. A completed release cannot receive new IDs through the importer.

Changed upstream files require explicit review and a new dataset-version/release
identity, not editing the old manifest or overwriting the old source snapshot.
Do not repoint existing diary selections during source refreshes.

## Verification

```sh
node --test artifacts/api-server/scripts/usda-source/*.test.mjs
```

The reader and CLI suites are hermetic. The SQL suite starts an isolated,
temporary PostgreSQL instance with no TCP listener, uses explicit socket/database
arguments, applies the actual migration, tests real role permissions, and removes
the instance afterward. It never connects to Supabase or an existing database.

Import completion receipts are in `receipts/`. An aggregate live verification
report records landed counts and whether the pre-existing catalog fingerprint
remained unchanged; it contains no patient data or credentials.

## Patient-facing work remains separate

Next, map precise source records into recognizable food families (for example,
one Ground Beef result with leanness/preparation choices). Retain source identity
for each variation instead of averaging distinct foods. Then connect supported
portions and extended nutrients through the API, saved-food/diary serialization,
and food-details UI. This import does not implement those screens.