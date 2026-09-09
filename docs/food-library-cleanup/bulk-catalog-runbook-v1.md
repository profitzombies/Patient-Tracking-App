# Bulk catalog v1

`bulk-catalog-source-v1.json` freezes the read-only 5,278-record eligible
denominator, 157 reviewed records, 112 pre-batch families, all 5,121 eligible
singleton source links and portions, existing identity contracts, and an ordered
raw-record digest. It contains no credentials.

`bulk-catalog-manifest-v1.json` is the source-linked release contract. Every
accepted row includes `sourceId`, `releaseId`, `catalogId`, `familyKey`,
`displayName`, `summary`, `dimensions`, original source portions, source MD5,
and evidence assertions. Numeric confidence is intentionally absent.
`bulk-catalog-report-v1.json` reconciles accepted, rejected, unresolved,
category, identity, and sampled mapping counts. The review version is
`bulk-catalog-v1`.

From the workspace root:

```sh
# Rebuild from the archived source without network access.
node artifacts/api-server/scripts/everyday-foods/bulk-catalog-generate.mjs
node artifacts/api-server/scripts/everyday-foods/bulk-catalog-test.mjs
node artifacts/api-server/scripts/everyday-foods/bulk-catalog-validate.mjs

# Pre-application inventory refresh only. The applied batch's frozen source
# must not be refreshed in place: its reviewed=157 baseline is intentional.
# This command is SELECT-only, but replaces the local frozen inventory.
node artifacts/api-server/scripts/everyday-foods/bulk-catalog-generate.mjs \
  --refresh-source --project <confirmed-project-ref>
```

To avoid touching checked-in outputs during review, pass `--output-dir /tmp/bulk`.
The generated forward migration is
`supabase/migrations/20261005110000_bulk_everyday_food_catalog.sql`. It refuses
changed baselines, source MD5s, non-singleton candidates, and duplicate record
counts before writing. Existing-family variants start after the prior maximum
`common_order`; only new `bulk-*` families receive new defaults. Nutrition and
portion snapshots are copied by `build_food_catalog_source_snapshot` from each
exact ready release—none are generated or averaged.

After the migration is separately approved and applied, pass
`bulk-catalog-extra-corpus-v1.json` to the shared search verifier and run the
mobile snapshot verifier with `--review-version bulk-catalog-v1`. The extra
corpus has exact-name and distinct bounded-alias checks for every new family,
plus representative supported and unsupported state constraints.

The generator deliberately rejects brands, specialized foods, generic source
headings, lower-usefulness identities, unsafe morphology, and cross-contract
aliases. Remaining quality concerns are visible rather than hidden: some exact
SR Legacy identities are less common regional foods, and long source summaries
remain verbose so that cut, species, state, preparation, salt, and skin evidence
is not silently discarded. Final live RPC ordering and mobile serving
presentation are post-apply gates owned by their respective verifiers.

## Applied batch and reproducible acceptance gates

This batch has been applied. Do not replay it or regenerate its evidence from
the post-application database. The application guard intentionally refuses an
already-applied batch. Use a newly versioned baseline/manifest for another batch.

Before application, the real mobile consumer must accept every proposed
snapshot, its source quantities, normalized display relationships, and documented
liquid defaults:

Also run the normalized-query ownership preflight before any future batch.
It flags conflicting original/generated family contracts for review; it does
not strip modifiers or automatically merge ambiguous names. The historical
batch needs its explicit reconciliation overlay:

```sh
node artifacts/api-server/scripts/everyday-foods/bulk-catalog-query-ownership-preflight.mjs \
  --extra-corpus docs/food-library-cleanup/bulk-catalog-extra-corpus-v1.json \
  --reconciliation docs/food-library-cleanup/bulk-family-reconciliation-v1.json
```

Mobile consumer preflight:

```sh
pnpm --filter @workspace/thinnr-mobile exec tsx \
  scripts/verify-bulk-serving-preflight.ts \
  --project <confirmed-project-ref> \
  --manifest ../../docs/food-library-cleanup/bulk-catalog-manifest-v1.json \
  --output ../../docs/food-library-cleanup/bulk-serving-preflight-v1.json

# No writes without --apply. Requires the exact manifest's successful preflight.
node artifacts/api-server/scripts/everyday-foods/apply-bulk-catalog.mjs \
  --project <confirmed-project-ref>
```

The application command, with the explicit `--apply` flag, writes the canonical
migration verbatim and records before/after immutable-data fingerprints in
`quarter-catalog-reconciliation.json`. It preserves original defaults, original
variant order, the source archive, and all non-candidate catalog rows.

Subsequent forward migrations are part of this release:

- `20261005120000_food_search_literal_tokens.sql`: treat query and alias tokens
  as literal text. Legitimate source punctuation must never become a regex.
- `20261005130000_food_search_familiar_family_ranking.sql`: keep familiar base
  foods ahead of newly grouped dishes in broad searches. Adds deliberate broad
  aliases, without changing original names, default source IDs or variant slots.
- `20261005140000_food_search_fast_literal_tokens.sql`: retain exact literal
  escaping using a single built-in regex replacement instead of a per-character
  set-returning aggregate.
- `20261005150000_food_search_materialized_family_hits.sql`: materialize matched
  families before lateral variant lookup and aggregate narrow alias text before
  joining full nutrition rows. Transactional equality assertions preserve the
  result contract; this migration changes no catalog data.
- `20261005160000_food_search_literal_identity_boundaries.sql`: recognize bounded
  food identities before interpreting remaining preparation words, including
  hyphenated names. Correct the source-verified Alfalfa Sprouts singleton's
  presentation name/aliases without changing its status or source facts.
- `20261005170000_food_family_duplicate_reconciliation.sql`: require complete
  identity-plus-constraint coverage before a family can suppress singletons;
  reconcile duplicate bread/pasta groups while keeping all source variations,
  original defaults, and legacy-key redirects. The explicit reconciliation
  overlay is required when checking the unchanged historical corpus.
- `20261005180000_food_family_redirect_wire_aliases.sql`: emit data-driven
  `familyKeyAliases` so remembered old-family configurations also restore when
  searching the canonical family. No source data changes.

Post-application checks:

```sh
pnpm --filter @workspace/thinnr-mobile exec tsx \
  scripts/verify-everyday-snapshot-contracts.ts \
  --project <confirmed-project-ref> --review-version bulk-catalog-v1 \
  --output ../../docs/food-library-cleanup/bulk-live-source-verification-v1.json

node artifacts/api-server/scripts/everyday-foods/verify-search-corpus.mjs \
  --project <confirmed-project-ref> \
  --extra-corpus docs/food-library-cleanup/bulk-catalog-extra-corpus-v1.json \
  --extra-corpus docs/food-library-cleanup/quarter-catalog-negative-corpus.json \
  --reconciliation docs/food-library-cleanup/bulk-family-reconciliation-v1.json \
  --output docs/food-library-cleanup/bulk-live-search-verification-v1.json
```

Also exercise the public HTTP search endpoint: SQL-only checks do not prove
cursor signatures or actual six-result API paging. The checked-in HTTP report
uses the `food-families-v5` cursor contract.

The current batch first selects 880 records across broad category floors, then
adds 283 source-supported variants only to those already accepted identities.
The fill does not introduce another lower-priority heading and never exceeds 12
records per family (the generated batch currently reaches five). It therefore
reaches 1,163 additional records without relaxing identity, source, parser, or
nutrition rules. The report lists all 2,037 otherwise valid unselected records
by category and family, including whether each was omitted because its heading
was below the initial common-food floor, its family cap was reached, or the
target was already complete.