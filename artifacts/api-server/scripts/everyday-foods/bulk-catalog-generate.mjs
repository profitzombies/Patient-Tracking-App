#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { managementQuery } from "../usda-source/import.mjs";
import { BASELINE, buildManifest, validateManifest, VERSION } from "./bulk-catalog-lib.mjs";

const root = resolve(import.meta.dirname, "../../../../");
const paths = {
  source: resolve(root, "docs/food-library-cleanup/bulk-catalog-source-v1.json"),
  manifest: resolve(root, "docs/food-library-cleanup/bulk-catalog-manifest-v1.json"),
  report: resolve(root, "docs/food-library-cleanup/bulk-catalog-report-v1.json"),
  corpus: resolve(root, "docs/food-library-cleanup/bulk-catalog-extra-corpus-v1.json"),
  preflight: resolve(root, "docs/food-library-cleanup/bulk-serving-preflight-v1.json"),
  migration: resolve(root, "supabase/migrations/20261005110000_bulk_everyday_food_catalog.sql"),
};
const { values } = parseArgs({ options: {
  project: { type: "string" }, "refresh-source": { type: "boolean" },
  "source-file": { type: "string" }, "output-dir": { type: "string" },
} });
if (values["output-dir"]) {
  paths.manifest = resolve(values["output-dir"], "bulk-catalog-manifest-v1.json");
  paths.report = resolve(values["output-dir"], "bulk-catalog-report-v1.json");
  paths.corpus = resolve(values["output-dir"], "bulk-catalog-extra-corpus-v1.json");
  paths.migration = resolve(values["output-dir"], "20261005110000_bulk_everyday_food_catalog.sql");
}

async function exportSource() {
  if (!/^[a-z0-9]+$/.test(values.project ?? "")) throw new Error("--project is required with --refresh-source");
  const query = managementQuery(values.project);
  return query(`select jsonb_build_object(
    'version','${VERSION}','frozen',jsonb_build_object(
      'eligible',(select count(*) from food_catalog_curation where eligibility<>'excluded'),
      'reviewed',(select count(*) from food_catalog_curation where eligibility='reviewed_family'),
      'families',(select count(*) from food_catalog_families)),
    'existingFamilies',(select coalesce(jsonb_agg(jsonb_build_object(
      'familyKey',f.family_key,'displayName',f.name,'aliases',f.aliases,
      'defaultCatalogId',f.default_catalog_id,
      'maxCommonOrder',coalesce((select max(v.common_order)from food_catalog_family_variants v
        where v.family_key=f.family_key),0))order by f.family_key),'[]')from food_catalog_families f),
    'records',coalesce(jsonb_agg(jsonb_build_object(
      'catalogId',c.id,'releaseId',f.release_id,'fdcId',f.fdc_id,
      'catalogName',c.name,'description',f.description,
      'foodCategory',f.raw_food->'foodCategory'->>'description',
      'portions',coalesce((select jsonb_agg(jsonb_build_object(
        'id',p->'id','amount',p->'amount','modifier',p->'modifier',
        'description',p->'portionDescription','unit',p->'measureUnit'->>'name',
        'grams',p->'gramWeight')order by ord)
        from jsonb_array_elements(coalesce(f.raw_food->'foodPortions','[]'))
          with ordinality x(p,ord)),'[]'::jsonb),
      'rawMd5',md5(f.raw_food::text)
    )order by f.description,f.fdc_id),'[]'::jsonb)
  )result
  from food_catalog_curation cur join food_catalog_items c on c.id=cur.catalog_id
  join usda_source_foods f on f.fdc_id=c.source_id::bigint
  join usda_source_releases r on r.id=f.release_id and r.status='ready'
  where cur.eligibility='safe_singleton'and c.source='usda_fdc'`);
}

const sourcePath = values["source-file"] ? resolve(values["source-file"]) : paths.source;
const source = values["refresh-source"] ? await exportSource() : JSON.parse(await readFile(sourcePath, "utf8"));
if (values["refresh-source"]) await writeFile(paths.source, `${JSON.stringify(source, null, 2)}\n`);
if (!source.existingFamilies) throw new Error("source archive lacks existingFamilies; refresh it with the current exporter");
const preflight = await readFile(paths.preflight, "utf8").then(JSON.parse).catch(() => ({ failures: [] }));
const consumerRejectedSourceIds = new Set(preflight.failures
  .filter(failure => /\bsnapshot parses$/.test(failure))
  .map(failure => failure.match(/^(\d+)/)?.[1]).filter(Boolean));
const manifest = buildManifest(source, source.existingFamilies, consumerRejectedSourceIds);
manifest.policy.consumerGate = `${consumerRejectedSourceIds.size} source records rejected because canonical live-helper snapshots failed the strict mobile parser; newly added bounded variants require the next read-only preflight before apply.`;
const report = validateManifest(manifest, source, source.existingFamilies);
if (!report.valid) throw new Error(`bulk manifest invalid:\n${report.errors.join("\n")}`);
report.reviewVersion = VERSION;
report.newFamilies = manifest.families.length;
report.existingFamilyAttachments = manifest.accepted.filter(row => row.existingFamily).length;
report.existingFamiliesExtended = new Set(manifest.accepted.filter(row => row.existingFamily)
  .map(row => row.familyKey)).size;
report.familiesByCategory = Object.fromEntries([
  "proteins", "seafood", "vegetables", "fruits", "grains",
  "legumes", "dairy", "nuts/seeds", "condiments", "beverages",
].map(category => [category, new Set(manifest.accepted.filter(row => row.category === category)
  .map(row => row.familyKey)).size]));
report.sampledMappingsByCategory = Object.fromEntries(Object.keys(report.familiesByCategory)
  .map(category => [category, manifest.accepted.filter(row => row.category === category)
    .slice(0, 5).map(row => ({
      sourceId: row.sourceId, canonicalName: row.canonicalName,
      familyKey: row.familyKey, displayName: row.displayName, summary: row.summary,
    }))]));
report.rejectionReasons = Object.fromEntries(Object.entries(Object.groupBy(manifest.rejected, row => row.reason))
  .map(([reason, rows]) => [reason, rows.length]).sort((a, b) => b[1] - a[1]));
const validUnselected = manifest.rejected.filter(row =>
  row.reason === "valid but not selected: target reached after bounded common-family variant ordering");
report.validUnselected = validUnselected.length;
report.validUnselectedByCategory = Object.fromEntries(Object.entries(Object.groupBy(validUnselected, row => row.category))
  .map(([category, rows]) => [category, rows.length]).sort((a, b) => b[1] - a[1]));
report.validUnselectedByFamily = Object.fromEntries(Object.entries(Object.groupBy(validUnselected, row => row.familyKey))
  .map(([familyKey, rows]) => [familyKey, {
    displayName: rows[0].displayName, category: rows[0].category, records: rows.length,
    reasonNotUsed: !manifest.accepted.some(row => row.familyKey === familyKey)
      ? "identity was below the broad category floor and target fill does not introduce new headings"
      : manifest.accepted.filter(row => row.familyKey === familyKey).length >= 12
        ? "bounded diversity cap of 12 exact variants per family was reached"
        : "the reviewed-record target was reached before this later exact variant",
  }]).sort((a, b) => b[1].records - a[1].records || a[0].localeCompare(b[0])));
const acceptedByFamily = Map.groupBy(manifest.accepted, row => row.familyKey);
const corpus = manifest.families.flatMap(family => {
  const winner = acceptedByFamily.get(family.familyKey)
    .toSorted((a, b) => a.commonOrder - b.commonOrder)[0];
  const alias = family.aliases.find(value => value.toLowerCase() !== family.displayName.toLowerCase());
  if (!alias) throw new Error(`${family.familyKey} lacks a distinct bounded alias`);
  const expected = {
    expect: "family", expectedFamily: family.familyKey,
    sourceId: winner.sourceId, releaseId: winner.releaseId,
  };
  return [
    { query: family.displayName.toLowerCase(), ...expected, assertion: "exact generated familiar name" },
    { query: alias, ...expected, assertion: "distinct bounded generated alias" },
  ];
});
for (const category of Object.keys(manifest.frozenBaseline).length ? [
  "proteins", "seafood", "vegetables", "fruits", "grains",
  "legumes", "dairy", "nuts/seeds", "condiments", "beverages",
] : []) {
  const family = manifest.families.find(f => f.category === category &&
    acceptedByFamily.get(f.familyKey).some(row => ["raw", "cooked", "dry"].includes(row.dimensions.state)));
  if (!family) continue;
  const rows = acceptedByFamily.get(family.familyKey);
  const supported = rows.filter(row => ["raw", "cooked", "dry"].includes(row.dimensions.state))
    .toSorted((a, b) => a.commonOrder - b.commonOrder)[0];
  corpus.push({
    query: `${family.displayName.toLowerCase()} ${supported.dimensions.state}`,
    expect: "family", expectedFamily: family.familyKey,
    sourceId: supported.sourceId, releaseId: supported.releaseId,
    assertion: `literal source-supported ${category} state`,
  });
  const unsupported = ["raw", "cooked", "dry"].find(state => !rows.some(row => row.dimensions.state === state));
  if (unsupported) corpus.push({
    query: `${family.displayName.toLowerCase()} ${unsupported}`,
    expectEmpty: true, forbiddenFamilies: [family.familyKey],
    assertion: `unsupported ${category} state is never synthesized`,
  });
}

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
const array = values => `array[${values.map(quote).join(",")}]::text[]`;
const familyRows = manifest.families.map(f =>
  `  (${quote(f.familyKey)},${quote(f.displayName)},${array(f.aliases)},${quote(f.category)})`).join(",\n");
const recordRows = manifest.accepted.map(r =>
  `  (${quote(r.familyKey)},${quote(r.releaseId)},${r.sourceId}::bigint,${quote(r.catalogId)}::uuid,${quote(r.summary)},${json(r.dimensions)},${r.commonOrder},${quote(r.category)},${quote(r.canonicalRawMd5)})`).join(",\n");
const migration = `-- GENERATED by bulk-catalog-generate.mjs from the frozen ${VERSION} manifest. Do not hand edit.
begin;
create temporary table bulk_families(family_key text,display_name text,aliases text[],category text)on commit drop;
insert into bulk_families values
${familyRows};
create temporary table bulk_records(family_key text,release_id text,fdc_id bigint,catalog_id uuid,summary text,dimensions jsonb,common_order integer,category text,raw_md5 text)on commit drop;
insert into bulk_records values
${recordRows};
do $$begin
  if(select count(*)from food_catalog_curation where eligibility<>'excluded')<>${BASELINE.eligible}
    or(select count(*)from food_catalog_curation where eligibility='reviewed_family')<>${BASELINE.reviewed}
    or(select count(*)from food_catalog_families)<>${BASELINE.families}
    then raise exception 'bulk catalog frozen baseline differs; regenerate and review instead of applying';end if;
  if(select count(*)from bulk_records)<>${manifest.accepted.length}
    or(select count(distinct catalog_id)from bulk_records)<>${manifest.accepted.length}
    then raise exception 'bulk catalog generated record cardinality differs';end if;
  if exists(select 1 from bulk_families b join food_catalog_families f using(family_key))
    then raise exception 'bulk migration would alter an existing family';end if;
  if exists(select 1 from bulk_records b left join food_catalog_items c on c.id=b.catalog_id
    left join food_catalog_curation q on q.catalog_id=c.id
    left join usda_source_foods f on f.release_id=b.release_id and f.fdc_id=b.fdc_id
    left join usda_source_releases r on r.id=f.release_id and r.status='ready'
    where c.id is null or q.eligibility<>'safe_singleton' or c.source<>'usda_fdc'
      or c.source_id<>b.fdc_id::text or f.fdc_id is null or md5(f.raw_food::text)<>b.raw_md5)
    then raise exception 'bulk source/catalog evidence differs from frozen manifest';end if;
  if(select count(*)from bulk_records b join food_catalog_items c on c.id=b.catalog_id
      join food_catalog_curation q on q.catalog_id=b.catalog_id
      join usda_source_foods f on f.release_id=b.release_id and f.fdc_id=b.fdc_id
      join usda_source_releases sr on sr.id=f.release_id and sr.status='ready')
      <>(select count(*)from bulk_records)
    then raise exception 'bulk ready-release/catalog/curation joins are incomplete';end if;
end$$;
insert into food_catalog_families(family_key,name,aliases,review_version)
select family_key,display_name,aliases,'${VERSION}'from bulk_families;
with snapshots as(
  select b.*,build_food_catalog_source_snapshot(release_id,fdc_id,family_key,summary,dimensions,'generic_source')snapshot
  from bulk_records b
),updated as(
  update food_catalog_items c set nutrition_snapshot=s.snapshot,
    measures=(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'label',p->>'label','grams',p->'grams','unit',p->>'unit','evidence',p->>'evidence'))order by ord)
      from jsonb_array_elements(s.snapshot->'portions')with ordinality x(p,ord)),
    provenance=c.provenance||jsonb_build_object('mapping','generic_source','familyReview','${VERSION}'),
    updated_at=now()from snapshots s where c.id=s.catalog_id returning c.id
)
insert into food_catalog_family_variants(family_key,catalog_id,release_id,source_revision,variant_summary,dimensions,nutrition_snapshot,common_order)
select s.family_key,s.catalog_id,s.release_id,s.release_id||':'||s.fdc_id,s.summary,s.dimensions,s.snapshot,s.common_order
from snapshots s join updated u on u.id=s.catalog_id;
update food_catalog_families f set default_catalog_id=v.catalog_id
from food_catalog_family_variants v where f.family_key=v.family_key and f.family_key like'bulk-%'and v.common_order=1;
insert into food_catalog_aliases(catalog_id,alias)
select f.default_catalog_id,a from bulk_families b join food_catalog_families f using(family_key)cross join unnest(b.aliases)a
on conflict(catalog_id,alias)do nothing;
update food_catalog_curation q set eligibility='reviewed_family',friendly_name=f.name,
  category=r.category,reason='bulk reviewed exact source-backed family variant',
  review_version='${VERSION}',source_revision=r.release_id||':'||r.fdc_id,reviewed_at=now()
from bulk_records r join food_catalog_families f using(family_key)where q.catalog_id=r.catalog_id;
do $$begin
  if(select count(*)from bulk_records r join food_catalog_curation q on q.catalog_id=r.catalog_id
    where q.eligibility='reviewed_family'and q.review_version='${VERSION}')
      <>(select count(*)from bulk_records)
    then raise exception 'bulk curation update missed accepted records';end if;
  if(select count(*)from food_catalog_curation where eligibility='reviewed_family')<>${BASELINE.reviewed + manifest.accepted.length}
    then raise exception 'bulk reviewed total failed to reconcile';end if;
  if exists(select 1 from bulk_records b join food_catalog_family_variants v using(family_key,catalog_id)
    where v.nutrition_snapshot<>build_food_catalog_source_snapshot(
      b.release_id,b.fdc_id,b.family_key,b.summary,b.dimensions,'generic_source'))
    then raise exception 'bulk snapshot/source reconciliation failed';end if;
end$$;
select jsonb_build_object('reviewVersion','${VERSION}','accepted',${manifest.accepted.length},
  'reviewedAfter',${BASELINE.reviewed + manifest.accepted.length})result;
commit;
`;
await Promise.all([
  writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
  writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(paths.corpus, `${JSON.stringify(corpus, null, 2)}\n`),
  writeFile(paths.migration, migration),
]);
console.log(JSON.stringify(report));