begin;

insert into public.food_catalog_items (
  kind, name, brand, serving_label, serving_grams,
  calories, protein, carbs, fat, measures,
  source, source_id, barcode, quality_status, provenance
)
values
  (
    'generic',
    'Chicken wing, meat and skin, cooked, roasted',
    null,
    '100 g',
    100,
    254,
    23.8,
    0,
    16.9,
    '[{"label":"100 g","grams":100},{"label":"1 oz","grams":28.349523125}]'::jsonb,
    'usda_fdc',
    '173630',
    null,
    'reviewed',
    '{"provider":"USDA FoodData Central","dataType":"SR Legacy","fdcId":"173630","release":"2018-04"}'::jsonb
  ),
  (
    'branded',
    '6 Count Traditional Wings',
    'Buffalo Wild Wings',
    '6 traditional wings',
    null,
    430,
    53,
    0,
    24,
    '[]'::jsonb,
    'openfoodfacts',
    'bww:6-count-traditional-wings',
    null,
    'community_verified',
    '{"provider":"Buffalo Wild Wings","document":"Buffalo Wild Wings Nutrition Guide","sourceUrl":"https://www.buffalowildwings.com/nutrition","reviewed":true}'::jsonb
  )
on conflict (source, source_id) do update set
  kind = excluded.kind,
  name = excluded.name,
  brand = excluded.brand,
  serving_label = excluded.serving_label,
  serving_grams = excluded.serving_grams,
  calories = excluded.calories,
  protein = excluded.protein,
  carbs = excluded.carbs,
  fat = excluded.fat,
  measures = excluded.measures,
  barcode = excluded.barcode,
  quality_status = excluded.quality_status,
  provenance = excluded.provenance,
  updated_at = now();

insert into public.food_catalog_aliases (catalog_id, alias)
select item.id, alias.value
from public.food_catalog_items item
cross join lateral (
  values
    ('chicken wings'),
    ('roasted chicken wings')
) as alias(value)
where item.source = 'usda_fdc' and item.source_id = '173630'
on conflict (catalog_id, alias) do nothing;

insert into public.food_catalog_aliases (catalog_id, alias)
select item.id, alias.value
from public.food_catalog_items item
cross join lateral (
  values
    ('Buffalo Wild Wings chicken wings'),
    ('Buffalo Wild Wings traditional wings'),
    ('BWW chicken wings')
) as alias(value)
where item.source = 'openfoodfacts' and item.source_id = 'bww:6-count-traditional-wings'
on conflict (catalog_id, alias) do nothing;

commit;