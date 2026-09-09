#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { managementQuery } from "../usda-source/import.mjs";

const { values } = parseArgs({ options: {
  project: { type: "string" },
  output: { type: "string" },
} });
if (!/^[a-z0-9]+$/.test(values.project ?? "")) {
  throw new Error("--project must be the explicitly confirmed Supabase project ref");
}
const query = managementQuery(values.project);
const result = await query(`
select jsonb_build_object(
  'archivedSourceFoods',(select count(*) from usda_source_foods),
  'archivedOnly',(select count(*) from usda_source_foods f where not exists(
    select 1 from food_catalog_items c where c.source='usda_fdc' and c.source_id=f.fdc_id::text)),
  'indexedSourceRows',(select count(*) from usda_source_foods f where exists(
    select 1 from food_catalog_items c where c.source='usda_fdc' and c.source_id=f.fdc_id::text)),
  'readyReleaseCoverage',(select jsonb_object_agg(r.id,jsonb_build_object(
    'archived',(select count(*) from usda_source_foods f where f.release_id=r.id),
    'indexed',(select count(*) from usda_source_foods f join food_catalog_items c
      on c.source='usda_fdc' and c.source_id=f.fdc_id::text where f.release_id=r.id)
  ))from usda_source_releases r where r.status='ready'),
  'sourceDisposition',jsonb_build_object(
    'archived_only_no_catalog_link',(select count(*) from usda_source_foods f where not exists(
      select 1 from food_catalog_items c where c.source='usda_fdc'and c.source_id=f.fdc_id::text)),
    'reviewed_family',(select count(*) from food_catalog_curation where eligibility='reviewed_family'),
    'safe_singleton_exact_all_token_only',(select count(*) from food_catalog_curation where eligibility='safe_singleton'),
    'excluded_specialized_or_non_generic',(select count(*) from food_catalog_curation where eligibility='excluded')
  ),
  'sourceFingerprint',(select md5(string_agg(id||':'||(manifest->>'sha256'),'|' order by id))
    from usda_source_releases where status='ready'),
  'catalogRows',(select count(*) from food_catalog_items),
  'genericRows',(select count(*) from food_catalog_items where kind='generic'),
  'families',(select count(*) from food_catalog_families),
  'variants',(select count(*) from food_catalog_family_variants),
  'aliases',(select count(*) from food_catalog_aliases),
  'snapshots',(select count(*) from food_catalog_items where nutrition_snapshot is not null),
  'classification',coalesce((select jsonb_object_agg(eligibility,n)
    from(select eligibility,count(*) n from food_catalog_curation group by eligibility)x),'{}'),
  'storedUnusableMeasureEvidenceSuppressedByApi',(select count(*) from food_catalog_items c
    cross join lateral jsonb_array_elements(c.measures)m
    where lower(coalesce(m->>'label','')) in ('quantity not specified','amount not specified','')),
  'rls',(select jsonb_object_agg(tablename,rowsecurity) from pg_tables
    where schemaname='public' and tablename in
      ('usda_source_releases','usda_source_foods','food_catalog_curation',
       'food_catalog_query_resolutions'))
) result`);
if (values.output) await writeFile(resolve(values.output), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));