-- Diet library: the 26 selectable diet frameworks plus "No specific diet,
-- just tracking", editable by HQ, read by patients only once published.
--
-- GENERATED FILE. Rendered from lib/diet-programs/src/catalog.ts by
-- lib/diet-programs/scripts/render-seed.ts; a test fails when the two drift.
-- Edit the catalog and re-render; never hand-edit the seed payload below.
--
-- Entries carry what the patient sees (name, summary, complexity, rule sheet,
-- sample day), the safety facts the server enforces (oversight note,
-- pregnancy block, which screening questions apply), the machine-readable fit
-- rules the shared food classifier reads, the hidden editorial facts
-- (evidence strength, supervision level, sources) and a review status. Every
-- update bumps the version and snapshots the prior row into
-- diet_library_versions, so HQ edits keep their history. Both tables are
-- service-role only: the API decides who sees drafts.

create table if not exists public.diet_library_entries (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9_]{2,64}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 600),
  complexity text not null check (complexity in ('simple', 'moderate', 'advanced')),
  rule_sheet jsonb not null default '[]'::jsonb check (jsonb_typeof(rule_sheet) = 'array'),
  sample_day jsonb not null default '[]'::jsonb check (jsonb_typeof(sample_day) = 'array'),
  oversight_note boolean not null default false,
  pregnancy_blocked boolean not null default false,
  screening_questions jsonb not null default '[]'::jsonb check (jsonb_typeof(screening_questions) = 'array'),
  fit_rules jsonb not null default '{"mode":"exclude","excludeTags":[]}'::jsonb check (jsonb_typeof(fit_rules) = 'object'),
  evidence_strength text not null default 'limited' check (evidence_strength in ('strong', 'moderate', 'limited', 'emerging')),
  supervision_level text not null default 'none' check (supervision_level in ('none', 'recommended', 'required')),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  review_status text not null default 'draft' check (review_status in ('draft', 'reviewed', 'published', 'retired')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  published_at timestamptz,
  sort_order integer not null default 0,
  version integer not null default 1 check (version >= 1),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.diet_library_entries is
  'HQ-editable diet library. Patients read published rows only (API-enforced); every update snapshots the prior row into diet_library_versions.';
alter table public.diet_library_entries enable row level security;
revoke all on public.diet_library_entries from public, anon, authenticated;
grant all on public.diet_library_entries to service_role;

create table if not exists public.diet_library_versions (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.diet_library_entries(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  changed_by uuid,
  change_note text check (change_note is null or char_length(change_note) <= 300),
  created_at timestamptz not null default now(),
  constraint diet_library_versions_entry_version_unique unique (entry_id, version)
);
comment on table public.diet_library_versions is
  'Append-only history of diet_library_entries: one snapshot per version, written by trigger on insert and every update.';
alter table public.diet_library_versions enable row level security;
revoke all on public.diet_library_versions from public, anon, authenticated;
grant all on public.diet_library_versions to service_role;

-- Version bump + timestamps on update; the editor sets updated_by.
create or replace function public.diet_library_entries_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.*) is not distinct from row(old.*) then return new; end if;
  new.version := old.version + 1;
  new.updated_at := now();
  new.created_at := old.created_at;
  if new.review_status = 'published' and old.review_status <> 'published' then
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end; $$;
drop trigger if exists diet_library_entries_before_update on public.diet_library_entries;
create trigger diet_library_entries_before_update
  before update on public.diet_library_entries
  for each row execute function public.diet_library_entries_before_update();

create or replace function public.diet_library_entries_snapshot()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_note text;
begin
  if tg_op = 'UPDATE' and row(new.*) is not distinct from row(old.*) then return new; end if;
  v_note := nullif(current_setting('diet_library.change_note', true), '');
  insert into public.diet_library_versions (entry_id, version, snapshot, changed_by, change_note)
  values (new.id, new.version, to_jsonb(new) - 'version', new.updated_by, v_note)
  on conflict (entry_id, version) do nothing;
  return new;
end; $$;
drop trigger if exists diet_library_entries_snapshot on public.diet_library_entries;
create trigger diet_library_entries_snapshot
  after insert or update on public.diet_library_entries
  for each row execute function public.diet_library_entries_snapshot();

-- Shared copy the API and the app render under every diet.
create table if not exists public.diet_library_settings (
  singleton boolean primary key default true check (singleton),
  disclaimer text not null,
  oversight_note_text text not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.diet_library_settings enable row level security;
revoke all on public.diet_library_settings from public, anon, authenticated;
grant all on public.diet_library_settings to service_role;
insert into public.diet_library_settings (singleton, disclaimer, oversight_note_text)
values (true, 'This information is general nutrition education, not medical advice. It does not diagnose, treat, cure or prevent any condition. Talk with your care team before changing how you eat, especially if you take medication, are pregnant or breastfeeding, or have a medical condition.', 'This plan works best with support. Consider talking to your care team before you start.')
on conflict (singleton) do nothing;

-- Seed: launch content. Existing rows (HQ edits) are left untouched.
insert into public.diet_library_entries (
  slug, name, summary, complexity, rule_sheet, sample_day, oversight_note, pregnancy_blocked,
  screening_questions, fit_rules, evidence_strength, supervision_level, sources, sort_order, review_status, published_at
)
select
  t.slug, t.name, t.summary, t.complexity, t.rule_sheet, t.sample_day, t.oversight_note, t.pregnancy_blocked,
  t.screening_questions, t.fit_rules, t.evidence_strength, t.supervision_level, t.sources, t.sort_order, t.review_status,
  case when t.review_status = 'published' then now() end
from jsonb_to_recordset($seed$[
  {
    "slug": "just_tracking",
    "name": "No specific diet, just tracking",
    "summary": "Log what you eat and drink without following a named plan. Your calorie and macro targets still come from your goals.",
    "complexity": "simple",
    "rule_sheet": [
      "There are no food rules. Any allergies, sensitivities, restrictions and dislikes you record still apply.",
      "Aim to log every meal, snack and drink so your targets mean something.",
      "Weigh in at your weekly check-in and keep your activity level current."
    ],
    "sample_day": [
      "Breakfast: whatever you normally eat, logged.",
      "Lunch: logged with portions.",
      "Dinner: logged with portions.",
      "Snacks and drinks: logged as you go."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": []
    },
    "evidence_strength": "strong",
    "supervision_level": "none",
    "sources": [
      "USDA Dietary Guidelines for Americans 2020-2025"
    ],
    "sort_order": 0,
    "review_status": "published"
  },
  {
    "slug": "intermittent_fasting",
    "name": "Intermittent fasting",
    "summary": "Eat within a daily window (for example 8 hours) and fast the rest of the day. What you eat stays flexible; when you eat is the rule.",
    "complexity": "simple",
    "rule_sheet": [
      "Pick an eating window and keep it most days. 16:8 (16 hours fasting, 8 hours eating) is the common starting point; 14:10 is gentler.",
      "During the fast: water, black coffee, plain tea. No calories, no sweetened drinks.",
      "Inside the window, build meals around protein, vegetables, fruit and whole grains so you are not short on nutrients.",
      "Do not fast if you take insulin or medication that can cause low blood sugar unless your prescriber has adjusted your plan.",
      "Stop and eat if you feel faint, shaky or confused.",
      "Your fasting window is saved in your diet settings and the coach uses it to time suggestions."
    ],
    "sample_day": [
      "Fasting 8 pm to 12 pm: water, black coffee, tea.",
      "12 pm: Grilled chicken salad with olive oil, chickpeas and an apple.",
      "3:30 pm: Greek yogurt with berries and walnuts.",
      "7 pm: Salmon, roasted vegetables and quinoa. Window closes at 8 pm."
    ],
    "oversight_note": true,
    "pregnancy_blocked": true,
    "screening_questions": [
      "medication",
      "pregnancy"
    ],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": []
    },
    "evidence_strength": "moderate",
    "supervision_level": "recommended",
    "sources": [
      "American Heart Association scientific statement on meal timing (2017)",
      "American Diabetes Association Standards of Care, nutrition therapy"
    ],
    "sort_order": 1,
    "review_status": "draft"
  },
  {
    "slug": "glp1_companion",
    "name": "GLP-1 companion",
    "summary": "Smaller, protein-first meals that sit well while you are on a GLP-1 medication, with attention to fluids, fiber and keeping muscle.",
    "complexity": "simple",
    "rule_sheet": [
      "Protein first at every meal: eggs, poultry, fish, lean meat, tofu, Greek yogurt or legumes. Aim for a palm-sized portion before anything else.",
      "Eat smaller meals and stop at the first sign of fullness. Nausea often follows big or greasy meals.",
      "Limit fried, very fatty and ultra-processed foods and sugary drinks; they are the most common triggers for stomach upset.",
      "Drink water through the day. Add fiber gradually (vegetables, fruit, oats, beans) to keep digestion moving.",
      "Keep moving and keep protein up to protect muscle while weight comes off.",
      "Tell your care team about vomiting, severe stomach pain or not being able to keep fluids down."
    ],
    "sample_day": [
      "Breakfast: Two scrambled eggs with spinach, half a slice of whole-grain toast.",
      "Lunch: Turkey and avocado lettuce wraps, cucumber slices.",
      "Snack: Cottage cheese with pineapple.",
      "Dinner: Baked cod, steamed green beans, small baked sweet potato.",
      "Fluids: water or herbal tea between meals."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "fried",
        "ultra_processed",
        "sweetened_beverage",
        "trans_fat"
      ],
      "limitTags": [
        "high_fat",
        "added_sugar",
        "alcohol",
        "carbonated"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "recommended",
    "sources": [
      "American Diabetes Association Standards of Care",
      "Academy of Nutrition and Dietetics guidance on GLP-1 receptor agonists"
    ],
    "sort_order": 2,
    "review_status": "draft"
  },
  {
    "slug": "mediterranean",
    "name": "Mediterranean",
    "summary": "Vegetables, fruit, whole grains, beans, nuts, olive oil and fish most days; poultry and dairy in moderation; red and processed meat rarely.",
    "complexity": "simple",
    "rule_sheet": [
      "Make vegetables, fruit, legumes, nuts and whole grains the base of every meal.",
      "Use extra-virgin olive oil as the main fat.",
      "Fish and seafood at least twice a week; poultry, eggs, cheese and yogurt in moderate amounts.",
      "Red meat a few times a month at most. Avoid processed meat, sugary drinks, added sugar and refined grains.",
      "Herbs, spices, garlic and citrus instead of salt.",
      "If you drink alcohol, keep it to a small glass of wine with a meal."
    ],
    "sample_day": [
      "Breakfast: Greek yogurt with figs, walnuts and a drizzle of honey.",
      "Lunch: Lentil and vegetable soup, whole-grain bread, olive oil.",
      "Snack: Hummus with carrot and pepper sticks.",
      "Dinner: Grilled sardines or salmon, tomato-cucumber salad, farro."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "processed_meat",
        "ultra_processed",
        "sweetened_beverage",
        "trans_fat"
      ],
      "limitTags": [
        "red_meat",
        "added_sugar",
        "refined_grain",
        "high_fat_dairy",
        "butter",
        "alcohol"
      ]
    },
    "evidence_strength": "strong",
    "supervision_level": "none",
    "sources": [
      "American Heart Association, Mediterranean diet guidance",
      "USDA Dietary Guidelines Healthy Mediterranean-Style Dietary Pattern"
    ],
    "sort_order": 3,
    "review_status": "draft"
  },
  {
    "slug": "keto",
    "name": "Keto",
    "summary": "Very low carbohydrate, moderate protein and high fat so the body runs mainly on fat. Strict and effective for some, but not for everyone.",
    "complexity": "advanced",
    "rule_sheet": [
      "Keep total carbohydrate very low, usually under 20 to 50 grams a day. Most of those come from non-starchy vegetables.",
      "No grains, bread, pasta, rice, sugar, sweets, sugary drinks, most fruit, potatoes, beans or lentils.",
      "Eat: meat, poultry, fish, eggs, cheese, butter, olive oil, avocado, nuts, seeds, leafy greens and other low-carb vegetables. Berries in small amounts.",
      "Drink plenty of water and add salt, potassium and magnesium-rich foods; the first two weeks can bring headaches and fatigue.",
      "If you take insulin or diabetes medication, your dose may need to change quickly. Do not start without your prescriber.",
      "Not recommended during pregnancy or breastfeeding, or with a history of pancreatitis, gallbladder disease or certain metabolic conditions."
    ],
    "sample_day": [
      "Breakfast: Omelet with cheese, spinach and avocado.",
      "Lunch: Chicken thigh salad with olive oil and feta.",
      "Snack: Macadamia nuts.",
      "Dinner: Ribeye or salmon with buttered broccoli and cauliflower mash."
    ],
    "oversight_note": true,
    "pregnancy_blocked": true,
    "screening_questions": [
      "medication",
      "pregnancy"
    ],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "grain",
        "whole_grain",
        "refined_grain",
        "gluten",
        "wheat",
        "corn",
        "rice",
        "added_sugar",
        "sweetened_beverage",
        "sweetener",
        "legume",
        "starchy_vegetable",
        "high_sugar_fruit",
        "honey",
        "beer"
      ],
      "limitTags": [
        "fruit",
        "milk"
      ],
      "maxCarbsPerServing": 10
    },
    "evidence_strength": "moderate",
    "supervision_level": "required",
    "sources": [
      "American Diabetes Association Standards of Care, low-carbohydrate eating patterns",
      "NIH/NIDDK nutrition guidance"
    ],
    "sort_order": 4,
    "review_status": "draft"
  },
  {
    "slug": "low_glycemic",
    "name": "Low-glycemic / plate method",
    "summary": "Half the plate vegetables, a quarter protein, a quarter slow carbohydrate. Steady energy without counting every gram.",
    "complexity": "simple",
    "rule_sheet": [
      "Plate method at each meal: half non-starchy vegetables, one quarter lean protein, one quarter whole grains, beans or starchy vegetables.",
      "Choose slow carbohydrates: oats, barley, quinoa, brown rice, beans, lentils, sweet potato, whole fruit.",
      "Skip white bread, white rice, pastries, candy, sugary cereal and sugary drinks.",
      "Pair carbohydrate with protein or fat to slow the rise in blood sugar.",
      "Water, unsweetened tea or coffee as the default drink."
    ],
    "sample_day": [
      "Breakfast: Steel-cut oats with berries and almonds.",
      "Lunch: Half plate salad greens, grilled chicken, half cup black beans.",
      "Snack: Apple with peanut butter.",
      "Dinner: Half plate roasted vegetables, baked fish, half cup quinoa."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "refined_grain",
        "added_sugar",
        "sweetened_beverage",
        "trans_fat"
      ],
      "limitTags": [
        "high_sugar_fruit",
        "fried",
        "ultra_processed"
      ]
    },
    "evidence_strength": "strong",
    "supervision_level": "none",
    "sources": [
      "American Diabetes Association Diabetes Plate Method",
      "USDA MyPlate"
    ],
    "sort_order": 5,
    "review_status": "draft"
  },
  {
    "slug": "whole_food_plant_based",
    "name": "Whole-food plant-based",
    "summary": "Mostly or entirely plants, as unprocessed as possible: vegetables, fruit, whole grains, legumes, nuts and seeds, with little added oil.",
    "complexity": "moderate",
    "rule_sheet": [
      "Build every meal from vegetables, fruit, whole grains, beans, lentils, nuts and seeds.",
      "Avoid meat, poultry, fish, eggs and dairy. If you keep small amounts of animal food, the Flexitarian plan may fit better.",
      "Minimize added oils, refined grains, added sugar and packaged foods with long ingredient lists.",
      "Get protein from legumes, tofu, tempeh, whole grains and nuts at every meal.",
      "Take a vitamin B12 supplement and check with your care team about vitamin D, iron and omega-3 sources."
    ],
    "sample_day": [
      "Breakfast: Oatmeal with banana, chia seeds and cinnamon.",
      "Lunch: Black bean and sweet potato bowl with brown rice and salsa.",
      "Snack: Edamame.",
      "Dinner: Lentil bolognese over whole-wheat pasta, big green salad with lemon-tahini dressing."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "meat",
        "red_meat",
        "pork",
        "poultry",
        "processed_meat",
        "organ_meat",
        "fish",
        "oily_fish",
        "shellfish",
        "high_mercury_fish",
        "raw_fish",
        "egg",
        "raw_egg",
        "dairy",
        "milk",
        "aged_cheese",
        "high_fat_dairy",
        "butter",
        "lactose",
        "ultra_processed",
        "refined_grain",
        "added_sugar",
        "sweetened_beverage",
        "fried",
        "trans_fat"
      ],
      "limitTags": [
        "olive_oil",
        "seed_oil",
        "honey"
      ]
    },
    "evidence_strength": "strong",
    "supervision_level": "none",
    "sources": [
      "USDA Dietary Guidelines Healthy Vegetarian Dietary Pattern",
      "American Heart Association, plant-based diets"
    ],
    "sort_order": 6,
    "review_status": "draft"
  },
  {
    "slug": "flexitarian",
    "name": "Flexitarian",
    "summary": "Mostly vegetarian with meat or fish now and then. The easiest way to eat more plants without giving anything up completely.",
    "complexity": "simple",
    "rule_sheet": [
      "Most meals vegetarian: legumes, tofu, eggs, dairy, whole grains, vegetables and fruit.",
      "Meat, poultry or fish a few times a week in modest portions; when you do, prefer fish and poultry over red meat.",
      "Limit processed meat, added sugar and ultra-processed snacks.",
      "Plan plant protein deliberately so you are not just dropping meat without a replacement."
    ],
    "sample_day": [
      "Breakfast: Veggie omelet with whole-grain toast.",
      "Lunch: Chickpea and quinoa salad.",
      "Snack: Trail mix.",
      "Dinner: Stir-fried tofu and vegetables (or chicken twice a week) with brown rice."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "processed_meat",
        "ultra_processed",
        "sweetened_beverage",
        "trans_fat"
      ],
      "limitTags": [
        "meat",
        "red_meat",
        "pork",
        "poultry",
        "added_sugar"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "USDA Dietary Guidelines Healthy Vegetarian Dietary Pattern"
    ],
    "sort_order": 7,
    "review_status": "draft"
  },
  {
    "slug": "paleo",
    "name": "Paleo",
    "summary": "Meat, fish, eggs, vegetables, fruit, nuts and seeds. No grains, legumes, dairy, refined sugar or processed food.",
    "complexity": "moderate",
    "rule_sheet": [
      "Eat: meat, poultry, fish, eggs, vegetables, fruit, nuts, seeds, olive oil, avocado and coconut oil.",
      "Avoid: all grains (including corn and rice), legumes (beans, lentils, peanuts, soy), dairy, refined sugar, seed oils and processed foods.",
      "Potatoes and sweet potatoes are allowed in most versions; keep portions moderate.",
      "Watch calcium and fiber: eat leafy greens, broccoli, sardines with bones and plenty of vegetables."
    ],
    "sample_day": [
      "Breakfast: Eggs with sautéed peppers and avocado.",
      "Lunch: Grilled steak salad with olive oil and pumpkin seeds.",
      "Snack: Apple and almonds.",
      "Dinner: Roast chicken, roasted sweet potato and Brussels sprouts."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "grain",
        "whole_grain",
        "refined_grain",
        "gluten",
        "wheat",
        "corn",
        "rice",
        "legume",
        "soy",
        "peanut",
        "dairy",
        "milk",
        "aged_cheese",
        "high_fat_dairy",
        "butter",
        "lactose",
        "added_sugar",
        "sweetened_beverage",
        "sweetener",
        "seed_oil",
        "ultra_processed",
        "artificial_additive",
        "trans_fat",
        "processed_meat"
      ],
      "limitTags": [
        "starchy_vegetable",
        "honey",
        "alcohol"
      ]
    },
    "evidence_strength": "limited",
    "supervision_level": "none",
    "sources": [
      "Academy of Nutrition and Dietetics review of Paleolithic diets"
    ],
    "sort_order": 8,
    "review_status": "draft"
  },
  {
    "slug": "whole30",
    "name": "Whole30",
    "summary": "A strict 30-day reset: whole foods only, with no sugar, alcohol, grains, legumes, dairy or additives. Then reintroduce one group at a time.",
    "complexity": "advanced",
    "rule_sheet": [
      "For 30 days eat meat, seafood, eggs, vegetables, fruit, natural fats, herbs and spices.",
      "No added sugar of any kind (real or artificial), no alcohol, no grains, no legumes (including peanuts and soy), no dairy, no carrageenan, MSG or sulfites.",
      "No recreating baked goods or treats with approved ingredients.",
      "Do not weigh yourself during the 30 days; your weekly check-in weight is recorded by your care team.",
      "After day 30 reintroduce one food group at a time over several days and note how you feel.",
      "Your start date is saved in your diet settings so the coach can count the days with you.",
      "Not appropriate during pregnancy or breastfeeding or with a history of disordered eating."
    ],
    "sample_day": [
      "Breakfast: Sweet potato hash with eggs and spinach.",
      "Lunch: Tuna salad with olive-oil mayo over greens.",
      "Snack: Hard-boiled egg and carrot sticks.",
      "Dinner: Pork chops, roasted cauliflower, sautéed kale."
    ],
    "oversight_note": true,
    "pregnancy_blocked": true,
    "screening_questions": [
      "eating_disorder",
      "pregnancy"
    ],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "grain",
        "whole_grain",
        "refined_grain",
        "gluten",
        "wheat",
        "corn",
        "rice",
        "legume",
        "soy",
        "peanut",
        "dairy",
        "milk",
        "aged_cheese",
        "high_fat_dairy",
        "butter",
        "lactose",
        "added_sugar",
        "sweetened_beverage",
        "sweetener",
        "honey",
        "alcohol",
        "beer",
        "ultra_processed",
        "artificial_additive",
        "trans_fat",
        "processed_meat"
      ]
    },
    "evidence_strength": "limited",
    "supervision_level": "recommended",
    "sources": [
      "Whole30 program rules (official)",
      "Academy of Nutrition and Dietetics commentary on elimination resets"
    ],
    "sort_order": 9,
    "review_status": "draft"
  },
  {
    "slug": "anti_inflammatory",
    "name": "Anti-inflammatory",
    "summary": "Colorful vegetables and fruit, oily fish, olive oil, nuts, whole grains and spices; little sugar, refined grain, fried or processed food.",
    "complexity": "simple",
    "rule_sheet": [
      "Fill plates with vegetables and fruit of many colors, especially leafy greens and berries.",
      "Oily fish (salmon, sardines, mackerel) two to three times a week; otherwise poultry, legumes, eggs.",
      "Olive oil, nuts and seeds as the main fats. Use turmeric, ginger, garlic and herbs generously.",
      "Avoid fried food, trans fats, processed meat, sugary drinks and sweets. Limit refined grains, red meat and alcohol.",
      "Whole grains and legumes for fiber."
    ],
    "sample_day": [
      "Breakfast: Overnight oats with blueberries, flax and walnuts.",
      "Lunch: Salmon and avocado bowl with brown rice and edamame.",
      "Snack: Orange and pistachios.",
      "Dinner: Turmeric chicken with roasted broccoli and sweet potato."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "fried",
        "trans_fat",
        "processed_meat",
        "sweetened_beverage",
        "ultra_processed"
      ],
      "limitTags": [
        "added_sugar",
        "refined_grain",
        "red_meat",
        "alcohol"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "American Heart Association, dietary patterns and inflammation",
      "USDA Dietary Guidelines"
    ],
    "sort_order": 10,
    "review_status": "draft"
  },
  {
    "slug": "carnivore",
    "name": "Carnivore",
    "summary": "Animal foods only: meat, fish, eggs and, for some, dairy. No plants at all. Highly restrictive; talk to your care team first.",
    "complexity": "advanced",
    "rule_sheet": [
      "Eat only animal foods: beef, lamb, pork, poultry, fish, shellfish, eggs, organ meats. Some versions allow butter, hard cheese and cream.",
      "No vegetables, fruit, grains, legumes, nuts, seeds, sugar, plant oils or alcohol.",
      "Salt to taste and drink plenty of water; electrolytes matter in the first weeks.",
      "This plan removes fiber and many vitamins found in plants. Your care team may want baseline and follow-up bloodwork.",
      "Not appropriate during pregnancy or breastfeeding, or with a history of disordered eating."
    ],
    "sample_day": [
      "Breakfast: Eggs and bacon.",
      "Lunch: Ground beef patties with butter.",
      "Dinner: Ribeye steak or salmon, salted.",
      "Drinks: water, bone broth."
    ],
    "oversight_note": true,
    "pregnancy_blocked": true,
    "screening_questions": [
      "eating_disorder",
      "pregnancy"
    ],
    "fit_rules": {
      "mode": "include",
      "includeTags": [
        "meat",
        "red_meat",
        "pork",
        "poultry",
        "processed_meat",
        "organ_meat",
        "fish",
        "oily_fish",
        "shellfish",
        "high_mercury_fish",
        "raw_fish",
        "egg",
        "organ_meat",
        "butter",
        "aged_cheese"
      ],
      "excludeTags": [
        "processed_meat",
        "added_sugar",
        "sweetener"
      ],
      "limitTags": [
        "dairy",
        "milk",
        "high_fat_dairy"
      ]
    },
    "evidence_strength": "emerging",
    "supervision_level": "required",
    "sources": [
      "USDA Dietary Guidelines (for the nutrients this pattern omits)",
      "Academy of Nutrition and Dietetics position on restrictive diets"
    ],
    "sort_order": 11,
    "review_status": "draft"
  },
  {
    "slug": "dash",
    "name": "DASH",
    "summary": "Dietary Approaches to Stop Hypertension: fruit, vegetables, whole grains, low-fat dairy, lean protein and nuts, with sodium kept low.",
    "complexity": "moderate",
    "rule_sheet": [
      "Daily: 4 to 5 servings each of vegetables and fruit, 6 to 8 of whole grains, 2 to 3 of low-fat dairy, up to 6 ounces of lean meat, poultry or fish.",
      "Weekly: 4 to 5 servings of nuts, seeds and legumes; sweets limited to 5 or fewer.",
      "Sodium under 2,300 mg a day (1,500 mg if your care team advises it). Skip cured meats, canned soups, salty snacks and most fast food.",
      "Choose potassium-rich foods: bananas, potatoes, beans, leafy greens, yogurt.",
      "Limit saturated fat, added sugar and alcohol."
    ],
    "sample_day": [
      "Breakfast: Oatmeal with banana and low-fat milk.",
      "Lunch: Turkey sandwich on whole-grain bread with lettuce, tomato and a side of fruit.",
      "Snack: Unsalted almonds and an orange.",
      "Dinner: Baked chicken, brown rice, steamed broccoli, side salad with vinaigrette."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "high_sodium",
        "processed_meat",
        "sweetened_beverage",
        "trans_fat",
        "ultra_processed"
      ],
      "limitTags": [
        "red_meat",
        "high_fat_dairy",
        "butter",
        "added_sugar",
        "alcohol",
        "fried"
      ]
    },
    "evidence_strength": "strong",
    "supervision_level": "none",
    "sources": [
      "NIH National Heart, Lung, and Blood Institute DASH Eating Plan",
      "American Heart Association"
    ],
    "sort_order": 12,
    "review_status": "draft"
  },
  {
    "slug": "volumetrics",
    "name": "Volumetrics",
    "summary": "Eat more of foods that are low in calories per bite (vegetables, fruit, broth soups, lean protein) and less of dense ones. Fullness without hunger.",
    "complexity": "simple",
    "rule_sheet": [
      "Start meals with a broth-based soup or a big salad.",
      "Fill up on water-rich foods: vegetables, fruit, lean protein, cooked whole grains, legumes, low-fat dairy.",
      "Keep energy-dense foods (fried food, pastries, cheese, nuts, oils, candy) to small, deliberate portions.",
      "Add vegetables to everything: omelets, pasta, sandwiches, stir-fries.",
      "Drink water rather than caloric drinks."
    ],
    "sample_day": [
      "Breakfast: Vegetable omelet with fruit salad.",
      "Lunch: Minestrone soup and a large mixed salad with grilled shrimp.",
      "Snack: Air-popped popcorn and grapes.",
      "Dinner: Turkey chili loaded with beans and peppers, side of roasted zucchini."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "sweetened_beverage",
        "trans_fat"
      ],
      "limitTags": [
        "fried",
        "high_fat",
        "added_sugar",
        "ultra_processed",
        "aged_cheese",
        "tree_nut",
        "peanut"
      ],
      "maxEnergyDensity": 4
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "Penn State Laboratory for the Study of Human Ingestive Behavior (Rolls)",
      "USDA Dietary Guidelines"
    ],
    "sort_order": 13,
    "review_status": "draft"
  },
  {
    "slug": "low_fodmap",
    "name": "Low FODMAP",
    "summary": "A short-term elimination of fermentable carbohydrates that commonly trigger gut symptoms, followed by careful reintroduction. Best done with a dietitian.",
    "complexity": "advanced",
    "rule_sheet": [
      "Phase 1 (2 to 6 weeks): avoid high-FODMAP foods such as onion, garlic, wheat, rye, most beans, apples, pears, stone fruit, honey, high-fructose corn syrup, milk, soft cheese, cashews, pistachios, sugar alcohols.",
      "Eat low-FODMAP alternatives: rice, oats, quinoa, potatoes, carrots, zucchini, spinach, bell pepper, strawberries, oranges, grapes, lactose-free dairy, hard cheese, eggs, meat, fish, tofu, peanuts, walnuts.",
      "Phase 2: reintroduce one FODMAP group at a time over three days and record symptoms.",
      "Phase 3: build a long-term pattern that avoids only your triggers. This is not meant to be permanent.",
      "Portion size changes FODMAP load; follow the Monash app servings when in doubt."
    ],
    "sample_day": [
      "Breakfast: Oats with lactose-free milk, strawberries and walnuts.",
      "Lunch: Rice bowl with grilled chicken, carrots, cucumber, spinach, sesame oil.",
      "Snack: Orange and a handful of peanuts.",
      "Dinner: Baked salmon, roasted potatoes, zucchini, infused garlic oil."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "high_fodmap",
        "honey",
        "sweetener"
      ],
      "limitTags": [
        "legume",
        "milk",
        "lactose",
        "wheat",
        "high_sugar_fruit"
      ]
    },
    "evidence_strength": "strong",
    "supervision_level": "recommended",
    "sources": [
      "Monash University Low FODMAP Diet program"
    ],
    "sort_order": 14,
    "review_status": "draft"
  },
  {
    "slug": "perimenopause_menopause",
    "name": "Perimenopause / menopause",
    "summary": "Protein and strength-supporting foods, calcium and vitamin D, fiber and plant foods, with less alcohol and added sugar to help with changes in weight, sleep and bone health.",
    "complexity": "simple",
    "rule_sheet": [
      "Protein at every meal (25 to 30 grams) to hold on to muscle: eggs, fish, poultry, dairy, legumes, tofu.",
      "Calcium-rich foods daily (dairy, fortified plant milk, sardines, leafy greens) and ask your care team about vitamin D.",
      "Mostly plants: vegetables, fruit, whole grains, legumes, nuts and seeds for fiber and phytoestrogens (soy, flax).",
      "Limit alcohol, caffeine late in the day, spicy food and added sugar if they worsen hot flashes or sleep.",
      "Pair this plan with resistance training two or more times a week."
    ],
    "sample_day": [
      "Breakfast: Greek yogurt with ground flax, berries and almonds.",
      "Lunch: Salmon salad with white beans, greens and olive oil.",
      "Snack: Edamame or a cheese stick with an apple.",
      "Dinner: Tofu and vegetable stir-fry over brown rice."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "sweetened_beverage",
        "trans_fat",
        "ultra_processed"
      ],
      "limitTags": [
        "alcohol",
        "caffeine",
        "added_sugar",
        "spicy",
        "refined_grain"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "The Menopause Society position statements",
      "USDA Dietary Guidelines for Americans"
    ],
    "sort_order": 15,
    "review_status": "draft"
  },
  {
    "slug": "fertility_pregnancy",
    "name": "Fertility / pregnancy",
    "summary": "Balanced eating for conception, pregnancy and breastfeeding: folate, iron, choline, omega-3s and enough calories, while avoiding foods that carry risk.",
    "complexity": "moderate",
    "rule_sheet": [
      "Take a prenatal vitamin with folic acid as your care team directs.",
      "Daily: vegetables, fruit, whole grains, legumes, dairy or fortified alternatives, eggs, poultry, lean meat and low-mercury fish (salmon, sardines, trout, shrimp) two to three times a week.",
      "Avoid alcohol entirely. Limit caffeine to about 200 mg a day (one 12-ounce coffee).",
      "Avoid raw or undercooked meat, fish, shellfish and eggs; unpasteurized milk and soft cheeses; deli meats unless heated; high-mercury fish (shark, swordfish, king mackerel, tilefish, bigeye tuna).",
      "Do not restrict calories or fast. Small frequent meals help with nausea; keep protein and fluids up.",
      "This plan sits alongside your prenatal care; it does not replace it."
    ],
    "sample_day": [
      "Breakfast: Fortified whole-grain cereal with milk and a banana; hard-boiled egg.",
      "Lunch: Lentil soup, whole-grain roll, spinach salad with orange segments.",
      "Snack: Yogurt with walnuts.",
      "Dinner: Baked salmon, quinoa, roasted carrots and broccoli."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "alcohol",
        "beer",
        "raw_fish",
        "raw_egg",
        "unpasteurized",
        "high_mercury_fish",
        "processed_meat",
        "trans_fat"
      ],
      "limitTags": [
        "caffeine",
        "coffee",
        "added_sugar",
        "ultra_processed"
      ]
    },
    "evidence_strength": "strong",
    "supervision_level": "recommended",
    "sources": [
      "American College of Obstetricians and Gynecologists, Nutrition During Pregnancy",
      "USDA Dietary Guidelines, pregnancy and lactation chapter",
      "FDA/EPA Advice About Eating Fish"
    ],
    "sort_order": 16,
    "review_status": "draft"
  },
  {
    "slug": "mind",
    "name": "MIND",
    "summary": "A blend of Mediterranean and DASH that emphasizes leafy greens, berries, nuts, olive oil, whole grains, beans, fish and poultry.",
    "complexity": "simple",
    "rule_sheet": [
      "Leafy greens six or more times a week and another vegetable daily.",
      "Berries at least twice a week; nuts five or more times a week; beans four or more times a week.",
      "Whole grains three or more servings a day; fish at least once a week; poultry twice a week.",
      "Olive oil as the main fat.",
      "Limit butter and margarine, cheese, red meat, fried and fast food, pastries and sweets."
    ],
    "sample_day": [
      "Breakfast: Whole-grain toast with almond butter and blueberries.",
      "Lunch: Kale and white bean salad with olive oil and walnuts.",
      "Snack: Strawberries.",
      "Dinner: Grilled chicken, farro, sautéed spinach with garlic."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "fried",
        "trans_fat",
        "sweetened_beverage",
        "ultra_processed"
      ],
      "limitTags": [
        "butter",
        "aged_cheese",
        "high_fat_dairy",
        "red_meat",
        "added_sugar",
        "refined_grain"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "Rush University MIND diet research",
      "NIH National Institute on Aging"
    ],
    "sort_order": 17,
    "review_status": "draft"
  },
  {
    "slug": "gerd_reflux",
    "name": "GERD / reflux",
    "summary": "Smaller meals and fewer trigger foods (fried, fatty, spicy, acidic, chocolate, mint, coffee, alcohol, fizzy drinks) to reduce heartburn.",
    "complexity": "simple",
    "rule_sheet": [
      "Eat smaller meals more often and stop eating two to three hours before lying down.",
      "Common triggers to cut back: fried and fatty foods, spicy food, tomato and citrus, chocolate, peppermint, coffee and other caffeine, carbonated drinks, alcohol, onion and garlic.",
      "Lean protein, oatmeal, bananas, melon, root vegetables, green vegetables, ginger and whole grains are usually well tolerated.",
      "Keep a note of which foods bother you; triggers vary by person.",
      "Raise the head of your bed and avoid tight waistbands."
    ],
    "sample_day": [
      "Breakfast: Oatmeal with banana and a splash of low-fat milk.",
      "Lunch: Turkey and avocado on whole-grain bread, baby carrots.",
      "Snack: Melon.",
      "Dinner: Baked chicken, roasted sweet potato, steamed green beans, ginger tea."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "fried",
        "spicy",
        "acidic",
        "citrus",
        "tomato",
        "chocolate",
        "mint",
        "coffee",
        "carbonated",
        "alcohol",
        "beer"
      ],
      "limitTags": [
        "high_fat",
        "caffeine",
        "high_fat_dairy",
        "butter"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "American College of Gastroenterology GERD guideline",
      "NIH/NIDDK eating, diet and nutrition for GER and GERD"
    ],
    "sort_order": 18,
    "review_status": "draft"
  },
  {
    "slug": "portfolio",
    "name": "Portfolio",
    "summary": "A plant-forward plan built around four cholesterol-lowering food groups: nuts, plant protein (soy and legumes), viscous fiber (oats, barley, okra, eggplant) and plant sterols.",
    "complexity": "moderate",
    "rule_sheet": [
      "Daily targets: about 45 g of nuts, 50 g of plant protein (soy, beans, lentils), 20 g of viscous fiber (oats, barley, psyllium, okra, eggplant, apples, citrus) and 2 g of plant sterols (fortified spreads or supplements).",
      "Mostly plant-based; keep saturated fat low by limiting red meat, butter and full-fat dairy. Fish and poultry in small amounts if desired.",
      "Choose whole grains and lots of vegetables and fruit.",
      "Monounsaturated fats (olive and canola oil, avocado) rather than butter."
    ],
    "sample_day": [
      "Breakfast: Oat bran porridge with soy milk, almonds and berries.",
      "Lunch: Tofu and vegetable stir-fry over barley.",
      "Snack: Apple with sterol-fortified spread on oat crackers.",
      "Dinner: Lentil and eggplant stew, side salad with olive oil."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "processed_meat",
        "trans_fat",
        "sweetened_beverage",
        "fried"
      ],
      "limitTags": [
        "red_meat",
        "pork",
        "butter",
        "high_fat_dairy",
        "aged_cheese",
        "egg",
        "added_sugar",
        "refined_grain"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "Canadian Cardiovascular Society dyslipidemia guideline (Portfolio diet)",
      "American Heart Association science advisory on the Portfolio diet (2023)"
    ],
    "sort_order": 19,
    "review_status": "draft"
  },
  {
    "slug": "nordic",
    "name": "Nordic",
    "summary": "The Mediterranean idea with northern foods: rye and oats, root vegetables, cabbage, berries, apples, oily fish, rapeseed oil and game or poultry.",
    "complexity": "simple",
    "rule_sheet": [
      "Whole grains, especially rye, oats and barley, every day.",
      "Plenty of vegetables (roots, cabbage family, legumes), fruit and berries.",
      "Fish and seafood two to three times a week; poultry and game over red meat.",
      "Rapeseed (canola) oil as the main fat; low-fat dairy in moderation.",
      "Limit added sugar, processed meat, salt and ultra-processed food."
    ],
    "sample_day": [
      "Breakfast: Oat porridge with lingonberries or blueberries and skyr.",
      "Lunch: Open-faced rye sandwich with smoked salmon, cucumber and dill.",
      "Snack: Apple and hazelnuts.",
      "Dinner: Baked cod, roasted root vegetables, braised red cabbage."
    ],
    "oversight_note": false,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "processed_meat",
        "ultra_processed",
        "sweetened_beverage",
        "trans_fat"
      ],
      "limitTags": [
        "red_meat",
        "added_sugar",
        "refined_grain",
        "high_sodium",
        "alcohol"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "none",
    "sources": [
      "Nordic Nutrition Recommendations 2023",
      "Nordic Council of Ministers New Nordic Diet"
    ],
    "sort_order": 20,
    "review_status": "draft"
  },
  {
    "slug": "low_purine",
    "name": "Low-purine",
    "summary": "Fewer purine-rich foods (organ meats, some seafood, beer) and more water, dairy, vegetables and whole grains.",
    "complexity": "moderate",
    "rule_sheet": [
      "Avoid organ meats (liver, kidney, sweetbreads), anchovies, sardines, herring, mussels, scallops, meat extracts and gravies, and beer.",
      "Limit red meat, pork, lamb and other seafood to small portions a few times a week.",
      "Avoid sugary drinks and foods sweetened with high-fructose corn syrup; limit other alcohol.",
      "Eat freely: vegetables (including the ones once thought risky, like spinach and asparagus), fruit, whole grains, legumes in moderation, low-fat dairy, eggs, nuts, coffee.",
      "Drink plenty of water through the day. Steady, gradual weight loss helps; crash dieting does not."
    ],
    "sample_day": [
      "Breakfast: Low-fat yogurt with cherries and granola.",
      "Lunch: Vegetable and white bean soup, whole-grain roll.",
      "Snack: Pear and a few walnuts.",
      "Dinner: Grilled chicken breast (small portion), brown rice, roasted vegetables; water with lemon."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "high_purine",
        "organ_meat",
        "beer",
        "sweetened_beverage"
      ],
      "limitTags": [
        "red_meat",
        "pork",
        "shellfish",
        "oily_fish",
        "alcohol",
        "added_sugar"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "recommended",
    "sources": [
      "American College of Rheumatology gout management guideline (2020)",
      "NIH/NIAMS gout resources"
    ],
    "sort_order": 21,
    "review_status": "draft"
  },
  {
    "slug": "low_oxalate",
    "name": "Low-oxalate",
    "summary": "Less of the highest-oxalate foods (spinach, rhubarb, almonds, beets, some beans) with calcium at meals and plenty of fluid.",
    "complexity": "moderate",
    "rule_sheet": [
      "Avoid the highest-oxalate foods: spinach, rhubarb, Swiss chard, beets and beet greens, almonds, cashews, peanuts, sesame, buckwheat, navy and soy beans, sweet potato in large amounts, chocolate in large amounts.",
      "Eat calcium-containing food with meals (dairy or fortified alternatives) so oxalate binds in the gut rather than the kidney.",
      "Drink enough fluid that urine stays pale, usually 2.5 to 3 liters a day.",
      "Keep sodium and animal protein moderate; vegetables and fruit otherwise unrestricted (kale, cabbage, cauliflower, cucumber, apples, melon, berries are low).",
      "Do not take high-dose vitamin C supplements."
    ],
    "sample_day": [
      "Breakfast: Eggs with mushrooms, white toast with butter, milk.",
      "Lunch: Chicken salad with cucumber, lettuce and cheese; grapes.",
      "Snack: Yogurt and melon.",
      "Dinner: Baked fish, white rice, roasted cauliflower and green beans."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "high_oxalate"
      ],
      "limitTags": [
        "tree_nut",
        "peanut",
        "sesame",
        "soy",
        "chocolate",
        "high_sodium",
        "starchy_vegetable"
      ]
    },
    "evidence_strength": "moderate",
    "supervision_level": "recommended",
    "sources": [
      "American Urological Association medical management of kidney stones guideline",
      "NIH/NIDDK eating, diet and nutrition for kidney stones"
    ],
    "sort_order": 22,
    "review_status": "draft"
  },
  {
    "slug": "aip",
    "name": "AIP (autoimmune protocol)",
    "summary": "A stricter version of Paleo that also removes eggs, nightshades, nuts, seeds and other common irritants for a time, then reintroduces them one by one.",
    "complexity": "advanced",
    "rule_sheet": [
      "Elimination phase (typically 30 to 90 days): eat meat, poultry, fish, shellfish, organ meats, non-nightshade vegetables, fruit in moderation, coconut, olive oil, avocado, bone broth, fermented vegetables, herbs (non-seed).",
      "Remove grains, legumes, dairy, eggs, nuts, seeds (including coffee, cocoa and seed spices), nightshades (tomato, potato, pepper, eggplant), alcohol, added sugar, sweeteners, food additives, NSAIDs where possible.",
      "Reintroduction: one food at a time in increasing amounts over five to seven days, recording symptoms.",
      "Because so much is removed, work with your care team on protein, calcium and overall calories, and do not stay in elimination longer than needed.",
      "Not appropriate during pregnancy or breastfeeding, or with a history of disordered eating."
    ],
    "sample_day": [
      "Breakfast: Turkey and sweet potato hash with sautéed kale.",
      "Lunch: Chicken soup with carrots, celery, zucchini and bone broth.",
      "Snack: Coconut yogurt with blueberries.",
      "Dinner: Grilled salmon, mashed cauliflower, roasted Brussels sprouts with olive oil."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [
      "eating_disorder"
    ],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "grain",
        "whole_grain",
        "refined_grain",
        "gluten",
        "wheat",
        "corn",
        "rice",
        "legume",
        "soy",
        "peanut",
        "dairy",
        "milk",
        "aged_cheese",
        "high_fat_dairy",
        "butter",
        "lactose",
        "egg",
        "raw_egg",
        "tree_nut",
        "seed",
        "sesame",
        "nightshade",
        "tomato",
        "added_sugar",
        "sweetened_beverage",
        "sweetener",
        "alcohol",
        "beer",
        "coffee",
        "chocolate",
        "artificial_additive",
        "ultra_processed",
        "seed_oil",
        "trans_fat",
        "processed_meat"
      ],
      "limitTags": [
        "fruit",
        "high_sugar_fruit",
        "honey"
      ]
    },
    "evidence_strength": "limited",
    "supervision_level": "required",
    "sources": [
      "Scripps Research AIP pilot studies (IBD, Hashimoto's)",
      "Academy of Nutrition and Dietetics commentary on elimination diets"
    ],
    "sort_order": 23,
    "review_status": "draft"
  },
  {
    "slug": "guided_elimination",
    "name": "Guided elimination",
    "summary": "Remove the most common food triggers (gluten, dairy, soy, eggs, corn, peanuts, tree nuts, shellfish, added sugar, alcohol) for a few weeks, then test them back one at a time.",
    "complexity": "advanced",
    "rule_sheet": [
      "Elimination phase (3 to 4 weeks): no gluten, dairy, soy, eggs, corn, peanuts, tree nuts, shellfish, added sugar or alcohol.",
      "Eat: meat, poultry, fish, rice, quinoa, oats labeled gluten-free, legumes other than soy and peanuts, vegetables, fruit, olive oil, seeds.",
      "Keep a daily symptom diary (energy, digestion, skin, sleep, mood).",
      "Reintroduction: one food group every three days in normal portions; stop and note any reaction before moving on.",
      "Keep out only what clearly caused symptoms; everything else comes back. Do not stay eliminated indefinitely.",
      "Not appropriate during pregnancy or breastfeeding, or with a history of disordered eating."
    ],
    "sample_day": [
      "Breakfast: Gluten-free oats with sunflower seeds and blueberries.",
      "Lunch: Grilled chicken, quinoa, roasted vegetables with olive oil.",
      "Snack: Pear and pumpkin seeds.",
      "Dinner: Baked salmon, brown rice, steamed broccoli."
    ],
    "oversight_note": true,
    "pregnancy_blocked": true,
    "screening_questions": [
      "eating_disorder",
      "pregnancy"
    ],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "gluten",
        "wheat",
        "dairy",
        "milk",
        "aged_cheese",
        "high_fat_dairy",
        "butter",
        "lactose",
        "soy",
        "egg",
        "raw_egg",
        "corn",
        "peanut",
        "tree_nut",
        "shellfish",
        "added_sugar",
        "sweetened_beverage",
        "sweetener",
        "alcohol",
        "beer",
        "ultra_processed",
        "artificial_additive"
      ]
    },
    "evidence_strength": "limited",
    "supervision_level": "recommended",
    "sources": [
      "Academy of Nutrition and Dietetics, elimination diets in practice",
      "American Academy of Allergy, Asthma & Immunology guidance on diagnosing food intolerance"
    ],
    "sort_order": 24,
    "review_status": "draft"
  },
  {
    "slug": "low_histamine",
    "name": "Low-histamine",
    "summary": "Fresh food cooked and eaten promptly, with fewer aged, fermented, cured and leftover foods that are high in histamine.",
    "complexity": "advanced",
    "rule_sheet": [
      "Avoid aged and fermented foods: aged cheese, cured and smoked meat, sauerkraut, kimchi, soy sauce, vinegar, yogurt, kombucha, alcohol (especially wine and beer).",
      "Avoid canned, smoked or leftover fish; eat fish very fresh or frozen-at-sea.",
      "Common plant triggers: tomato, spinach, eggplant, avocado, citrus, strawberries, bananas, pineapple, dried fruit, chocolate, nuts.",
      "Eat freshly cooked meat and poultry, most fresh vegetables, apples, pears, melon, blueberries, rice, quinoa, oats, eggs (cooked), olive oil, fresh herbs.",
      "Cook fresh and freeze leftovers right away; histamine rises as food sits.",
      "Work with your care team; this plan is diagnostic and short-term, and symptoms can have other causes."
    ],
    "sample_day": [
      "Breakfast: Oatmeal with pear and a drizzle of maple syrup.",
      "Lunch: Freshly cooked chicken with rice and steamed zucchini.",
      "Snack: Apple slices and rice cakes.",
      "Dinner: Fresh-cooked turkey patties, mashed sweet potato, green beans."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "high_histamine",
        "fermented",
        "aged_cheese",
        "processed_meat",
        "leftover",
        "alcohol",
        "beer",
        "tomato",
        "citrus",
        "chocolate",
        "artificial_additive"
      ],
      "limitTags": [
        "tree_nut",
        "peanut",
        "fish",
        "oily_fish",
        "shellfish",
        "nightshade",
        "high_sugar_fruit"
      ]
    },
    "evidence_strength": "limited",
    "supervision_level": "recommended",
    "sources": [
      "Swiss Interest Group Histamine Intolerance food lists",
      "Academy of Nutrition and Dietetics commentary on histamine intolerance"
    ],
    "sort_order": 25,
    "review_status": "draft"
  },
  {
    "slug": "specific_carbohydrate",
    "name": "Specific Carbohydrate Diet",
    "summary": "Only simple carbohydrates (monosaccharides) from fruit, honey, non-starchy vegetables and properly fermented yogurt; no grains, starches, lactose or sucrose.",
    "complexity": "advanced",
    "rule_sheet": [
      "Allowed: fresh meat, poultry, fish, eggs, non-starchy vegetables, most fruit, nuts and nut flours, honey, 24-hour home-fermented yogurt, aged natural cheeses, dry wine in small amounts, oils and butter.",
      "Not allowed: all grains (wheat, rice, corn, oats), potatoes, yams, sugar and syrups other than honey, milk and most commercial dairy, soy, canned vegetables, processed meats, chocolate, most packaged foods with additives.",
      "Legumes (lentils, split peas, navy beans) only after the first months and soaked overnight.",
      "Start with the introductory phase (broths, well-cooked foods) for a few days and widen slowly as tolerated.",
      "Because the plan is strict, your care team may want to watch weight, fiber and micronutrients."
    ],
    "sample_day": [
      "Breakfast: Eggs with sautéed spinach and homemade SCD yogurt with honey.",
      "Lunch: Chicken salad with avocado and cucumber over greens.",
      "Snack: Almond-flour muffin and grapes.",
      "Dinner: Roast beef, butternut squash purée, green beans with butter."
    ],
    "oversight_note": true,
    "pregnancy_blocked": false,
    "screening_questions": [],
    "fit_rules": {
      "mode": "exclude",
      "excludeTags": [
        "grain",
        "whole_grain",
        "refined_grain",
        "gluten",
        "wheat",
        "corn",
        "rice",
        "starchy_vegetable",
        "added_sugar",
        "sweetened_beverage",
        "sweetener",
        "milk",
        "lactose",
        "soy",
        "processed_meat",
        "chocolate",
        "artificial_additive",
        "ultra_processed"
      ],
      "limitTags": [
        "legume",
        "alcohol"
      ]
    },
    "evidence_strength": "limited",
    "supervision_level": "recommended",
    "sources": [
      "Breaking the Vicious Cycle (Gottschall) legal/illegal food list",
      "Crohn's & Colitis Foundation diet resources",
      "Nutrition Therapy for IBD (NIMBUS) studies"
    ],
    "sort_order": 26,
    "review_status": "draft"
  }
]$seed$::jsonb) as t(
  slug text, name text, summary text, complexity text, rule_sheet jsonb, sample_day jsonb, oversight_note boolean,
  pregnancy_blocked boolean, screening_questions jsonb, fit_rules jsonb, evidence_strength text, supervision_level text,
  sources jsonb, sort_order integer, review_status text
)
on conflict (slug) do nothing;
