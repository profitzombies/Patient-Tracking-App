#!/usr/bin/env node
import { parseArgs } from "node:util";
import { managementQuery } from "../usda-source/import.mjs";

const { values } = parseArgs({ options: { project: { type: "string" } } });
if (!/^[a-z0-9]+$/.test(values.project ?? "")) throw new Error("--project is required");
const query = managementQuery(values.project);
const result = await query(`
  select jsonb_build_object(
    'generatedAt',now(),
    'source','immutable ready USDA archive joined to landed catalog variants',
    'records',coalesce(jsonb_agg(jsonb_build_object(
      'source',jsonb_build_object('release',f.release_id,'id',f.fdc_id,'description',f.description),
      'family',jsonb_build_object('key',v.family_key,'name',fam.name),
      'aliases',fam.aliases,
      'variant',jsonb_build_object('summary',v.variant_summary,'dimensions',v.dimensions),
      'portions',coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',p->'id','amount',p->'amount',
          'modifier',p->'modifier','description',p->'portionDescription',
          'unit',p->'measureUnit'->>'name','grams',p->'gramWeight'
        )order by ord)
        from jsonb_array_elements(coalesce(f.raw_food->'foodPortions','[]'::jsonb))
          with ordinality x(p,ord)
      ),'[]'::jsonb)
    )order by fam.name,v.common_order,f.fdc_id),'[]'::jsonb)
  ) result
  from food_catalog_family_variants v
  join food_catalog_families fam using(family_key)
  join food_catalog_items c on c.id=v.catalog_id
  join usda_source_foods f on f.release_id=v.release_id
    and f.fdc_id=split_part(v.source_revision,':',2)::bigint
  where v.family_key like'everyday-%'
`);
console.log(JSON.stringify(result));