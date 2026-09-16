-- Product pages and subscription plans.
--
-- Every product gains page content (tagline, format, benefits, how to take
-- it, supplement facts / ingredients, FAQs, disclaimer) and a category, all
-- editable by HQ and audited through billing_catalog_changes
-- (`product_updated`). Products also declare which subscription cadences
-- they offer (any subset of every 2/4/6/8/10/12 weeks) and a default.
--
-- Billing settings gain the subscribe-and-save switch (enabled + percent).
-- When it is off, no discount is quoted or charged anywhere; the percent is
-- kept so switching it back on restores the last value.
--
-- Office prices gain a per-cadence mirror of Stripe recurring prices on the
-- connected account (`stripe_cadence_prices`). The legacy `stripe_price_id`
-- stays the full-price 4-week price that existing subscriptions renew on.
--
-- Everything is additive; existing columns and constraints are untouched.

alter table public.billing_products
  add column if not exists category text not null default 'supplement',
  add column if not exists tagline text not null default '',
  add column if not exists format text not null default '',
  add column if not exists benefits jsonb not null default '[]'::jsonb,
  add column if not exists how_to_take text not null default '',
  add column if not exists facts_title text not null default '',
  add column if not exists facts jsonb not null default '[]'::jsonb,
  add column if not exists faqs jsonb not null default '[]'::jsonb,
  add column if not exists disclaimer text not null default '',
  add column if not exists offered_cadences_weeks integer[] not null default '{4}',
  add column if not exists default_cadence_weeks integer not null default 4;

alter table public.billing_products
  drop constraint if exists billing_products_category_check;
alter table public.billing_products
  add constraint billing_products_category_check
  check (category in ('drops', 'supplement', 'bundle'));

alter table public.billing_products
  drop constraint if exists billing_products_page_json_check;
alter table public.billing_products
  add constraint billing_products_page_json_check
  check (
    jsonb_typeof(benefits) = 'array' and jsonb_typeof(facts) = 'array' and jsonb_typeof(faqs) = 'array'
  );

-- Offered cadences: non-empty, drawn from the fixed set, and the default is
-- one of them.
alter table public.billing_products
  drop constraint if exists billing_products_cadences_check;
alter table public.billing_products
  add constraint billing_products_cadences_check
  check (
    cardinality(offered_cadences_weeks) > 0
    and offered_cadences_weeks <@ array[2, 4, 6, 8, 10, 12]
    and default_cadence_weeks = any (offered_cadences_weeks)
  );

alter table public.billing_settings
  add column if not exists subscribe_save_enabled boolean not null default false,
  add column if not exists subscribe_save_percent integer not null default 10;

alter table public.billing_settings
  drop constraint if exists billing_settings_subscribe_save_percent_check;
alter table public.billing_settings
  add constraint billing_settings_subscribe_save_percent_check
  check (subscribe_save_percent between 0 and 90);

-- { "<weeks>": { "price_id": "price_…", "unit_amount_cents": n, "shipping_price_id": "price_…" } }
alter table public.billing_office_prices
  add column if not exists stripe_cadence_prices jsonb not null default '{}'::jsonb;

alter table public.billing_office_prices
  drop constraint if exists billing_office_prices_cadence_json_check;
alter table public.billing_office_prices
  add constraint billing_office_prices_cadence_json_check
  check (jsonb_typeof(stripe_cadence_prices) = 'object');

-- Initial product-page content, drafted from the THINNR program documents
-- (getthinnr.com copy quoted verbatim where the documents give wording,
-- plain descriptive copy otherwise). Only rows that have never been given a
-- tagline are filled, so HQ edits survive a re-run. Descriptions HQ already
-- wrote are kept.

update public.billing_products set
  category = 'supplement', tagline = 'Metabolic & Appetite Support',
  description = case when description = '' then 'Thinnr Control helps support healthy appetite and metabolic function through a blend of natural ingredients including African Mango, Raspberry Ketones, Green Coffee Bean, and Green Tea.**' else description end,
  format = 'Dietary Supplement · 60 Vegetarian Capsules', benefits = '["Helps support healthy appetite**","Helps support healthy metabolic function**","Helps support healthy blood sugar levels already within normal range**","Helps support healthy energy levels**"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'Key Ingredients', facts = '[{"name":"African Mango","detail":"Helps support healthy appetite and metabolic function.**"},{"name":"Raspberry Ketones","detail":"Helps support healthy metabolic function.**"},{"name":"Green Coffee Bean Extract","detail":"Rich in chlorogenic acids to help support healthy glucose metabolism.**"},{"name":"Green Tea Extract","detail":"Contains catechins and caffeine to help support healthy energy levels.**"}]'::jsonb, faqs = '[{"question":"Where can I get Control?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'control' and tagline = '';

update public.billing_products set
  category = 'supplement', tagline = 'Glucose Stabilization & Metabolic Support',
  description = case when description = '' then 'Thinnr Regulate helps support healthy glucose levels and metabolic function with Berberine, Bitter Melon, and Banaba Leaf.**' else description end,
  format = 'Dietary Supplement · 60 Vegetarian Capsules', benefits = '["Helps support healthy metabolic function*","Helps support healthy blood sugar levels already within normal range*","Helps support digestive wellness*","Helps support a healthy gut microbiome**"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'Key Ingredients', facts = '[{"name":"Berberine","detail":"Helps support healthy glucose levels and metabolic function.**"},{"name":"Bitter Melon","detail":"Helps support healthy metabolic function and digestive wellness.**"},{"name":"Banaba Leaf","detail":"Contains corosolic acid that may help support healthy glucose metabolism.**"}]'::jsonb, faqs = '[{"question":"Where can I get Regulate?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'regulate' and tagline = '';

update public.billing_products set
  category = 'supplement', tagline = 'Liver & Kidney Support',
  description = case when description = '' then 'Thinnr Detox helps support your body''s natural detoxification processes. This formula helps support liver health and digestive wellness.**' else description end,
  format = 'Dietary Supplement · 90 Vegetarian Capsules', benefits = '["Helps support cellular energy and liver health*","Helps support healthy bile function and digestion*","Helps support healthy fluid balance*","Helps provide antioxidant support for liver health*","Helps support protein and fat digestion with digestive enzymes*"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'Key Ingredients', facts = '[{"name":"Solarplast®","detail":"Proprietary chloroplast complex from spinach that helps support cellular energy and liver health.**"},{"name":"Artichoke Leaf","detail":"Helps support healthy bile function and digestive wellness.**"},{"name":"Dandelion Leaf","detail":"Helps support healthy fluid balance and the body''s natural processes.**"},{"name":"Milk Thistle","detail":"Contains silymarin that helps provide antioxidant support for liver health.**"},{"name":"Protease SP","detail":"Digestive enzyme that helps support protein digestion.**"},{"name":"Lipase","detail":"Helps support fat digestion and nutrient absorption.**"}]'::jsonb, faqs = '[{"question":"Where can I get Detox?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'detox' and tagline = '';

update public.billing_products set
  category = 'supplement', tagline = 'Plant-Based Colon & Digestive Support',
  description = case when description = '' then 'A superior dietary supplement designed to naturally soothe and regulate your digestive system. Its primary ingredient, derived from the Plantago ovata plant, offers a gentle yet effective solution for digestive health.' else description end,
  format = 'Dietary Supplement · 120 Capsules · Psyllium-Based Formula', benefits = '["Free from artificial sweeteners, sugar, and harmful chemicals**","Psyllium is resistant to fermentation, helping to support digestive comfort**","Helps support digestive regularity and comfort**","Helps support healthy cholesterol levels already within normal range**","Helps support colon health as part of a healthy diet**"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'Key Ingredient', facts = '[{"name":"Psyllium (Plantago ovata)","detail":"Derived from the Plantago ovata plant, psyllium is renowned for its effectiveness in increasing stool bulk and softening, making it easier to pass without the harsh side effects often associated with synthetic laxatives."}]'::jsonb, faqs = '[{"question":"When should I start a fiber supplement?","answer":"If the patient has a pre-existing history of constipation, it is recommended that they start taking a sugar-free fiber supplement beginning on the first day of the Thinnr Metabolic Thinning Phase."},{"question":"Where can I get Fiber?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'fiber' and tagline = '';

update public.billing_products set
  category = 'supplement', tagline = 'Powerful Muscle & Mind Support',
  description = case when description = '' then 'A formula that combines two ingredients to help support muscle maintenance, energy production, and cognitive function.** Made for everyday strength.' else description end,
  format = 'Dietary Supplement · 480 Grams · 5g Creatine + 3g HMB Formula', benefits = '["Creatine helps support ATP production, while HMB helps support muscle maintenance**","Creatine helps support brain energy metabolism and cognitive function**","HMB helps support lean mass during weight management programs**","Together, these compounds help support post-workout recovery**","Helps support muscle maintenance for those transitioning off weight management programs**"]'::jsonb, how_to_take = 'Take 1 serving daily (5g Creatine Monohydrate + 3g HMB). Can be mixed into water, shakes, or your favorite beverage.',
  facts_title = 'Supplement Facts · Per Serving', facts = '[{"name":"Creatine Monohydrate","detail":"5 g — helps support lean muscle maintenance, energy during workouts, and cognitive function.**"},{"name":"HMB (β-Hydroxy β-Methylbutyrate)","detail":"3 g — helps support muscle maintenance, recovery, and strength during calorie restriction.**"}]'::jsonb, faqs = '[{"question":"Where can I get Creatine+?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'creatine-plus' and tagline = '';

update public.billing_products set
  category = 'supplement', tagline = 'Multi-B with 5-MTHF',
  description = case when description = '' then 'Highly absorbable, bioactive forms of essential B vitamins in a convenient liquid formula. Uses methylated forms for maximum bioavailability, making them easier for your body to absorb and utilize.**' else description end,
  format = 'Dietary Supplement · Liquid Formula', benefits = '["Supports cellular energy metabolism and reduces fatigue**","Promotes healthy brain function and mental clarity**","Supports healthy homocysteine levels and heart function**","Helps support healthy neurological function**","Supports balanced mood, stress resilience, and restful sleep**"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'Ingredients', facts = '[{"name":"5-MTHF (Methylfolate)","detail":"The methylated, active form of folic acid needed for protein metabolism, RNA and DNA repair, and red blood cell formation."},{"name":"Vitamin B12 (Methylcobalamin)","detail":"Required for red blood cell formation, DNA synthesis, and proper neurological function."},{"name":"Vitamin B6 (Pyridoxal 5-Phosphate)","detail":"Bioactive, water-soluble vitamin utilized by the nervous and immune systems."},{"name":"Vitamin B6 (Pyridoxine HCl)","detail":"Essential for red blood cell metabolism and hemoglobin production."}]'::jsonb, faqs = '[{"question":"Where can I get B-Active?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'b-active' and tagline = '';

update public.billing_products set
  category = 'drops', tagline = 'Supports Any Weight Loss, Including Prescription Programs',
  description = case when description = '' then 'THINNR Boost has many of the benefits of Thinnr Protocol with the exception of hunger support. Thinnr Boost is meant to be used in conjunction with any other weight management program, including prescription options.' else description end,
  format = 'Homeopathic OTC Medication · Sublingual Drops', benefits = '["Homeopathic OTC formulation using HPUS-listed ingredients*","Designed to support the body during any weight management program*","Can be used alongside prescription weight management programs","Sublingual drops - easy administration, no injections required"]'::jsonb, how_to_take = 'Sublingual drops. Take as directed by your THINNR provider.',
  facts_title = 'Active Ingredients (HPUS)', facts = '[{"name":"Adrenocorticotrophin (ACTH)","detail":null},{"name":"Adeps suillus","detail":null},{"name":"Adrenalinum","detail":null},{"name":"Calcarea carbonica","detail":null},{"name":"Pituitarum","detail":null},{"name":"Thyroidinum","detail":null},{"name":"Chelidonium","detail":null}]'::jsonb, faqs = '[{"question":"Do Protocol or Boost have any side effects?","answer":"Homeopathic products typically have little to no side effects because they use extremely diluted amounts of natural substances, often to the point where only trace elements remain. This high level of dilution means the body isn’t exposed to significant chemical doses, reducing the likelihood of adverse reactions. Additionally, homeopathy aims to stimulate the body’s natural healing response rather than override it, making it generally gentle and well-tolerated."},{"question":"What are the contraindications to Thinnr Boost and Thinnr Protocol?","answer":"Individuals prohibited from using Thinnr Boost and Thinnr Protocol include Women who are pregnant or breastfeeding, a person with active cancer, and should not be taken by someone who has recently (last 3-4 weeks) experienced acute gallbladder problems."},{"question":"Will a woman on birth control pills still see results?","answer":"Birth control pills should not negatively impact Thinnr Protocol or Thinnr Boost effectiveness."},{"question":"Is there iodine or shellfish in Boost?","answer":"There is no iodine in Thinnr Protocol or Boost, and no shellfish is used in the Thinnr Protocol or Boost formula manufacturing."}]'::jsonb, disclaimer = '*Claims for this product are based on traditional homeopathic practice, not accepted modern medical evidence. The FDA has not evaluated these claims.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'boost' and tagline = '';

update public.billing_products set
  category = 'bundle', tagline = 'Long-Term Weight Maintenance',
  description = case when description = '' then 'A comprehensive 3-part system designed to support long-term weight maintenance, metabolic health, and overall wellness after completing your weight management journey.' else description end,
  format = '3-Part Dietary Supplement System · Regulate + Detox + Control', benefits = '["Helps support healthy metabolic function and blood sugar levels already within normal range*","Helps support healthy digestion and feelings of fullness*","Helps support liver health and digestive wellness*","Helps support healthy appetite for easier maintenance*","Helps support healthy energy levels*"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'What''s in the Stack', facts = '[{"name":"Regulate","detail":"Combines the power of Berberine, Bitter Melon, and Banaba Leaf to support sustainable weight management and metabolic health."},{"name":"Detox","detail":"Designed to support liver health, detoxification, and weight maintenance with Solarplast, Artichoke Leaf, Dandelion Leaf, Milk Thistle, Protease, and Lipase."},{"name":"Control","detail":"Crafted to help support appetite regulation, hormonal balance, and metabolism with African Mango, Raspberry Ketone, Green Coffee Bean, and Green Tea.**"}]'::jsonb, faqs = '[{"question":"Where can I get Maintenance Stack?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'maintenance-stack' and tagline = '';

update public.billing_products set
  category = 'bundle', tagline = 'Long-Term Weight Maintenance',
  description = case when description = '' then 'A two-product version of the Maintenance Stack. Your provider chooses which two of Regulate, Detox, and Control fit your maintenance plan.' else description end,
  format = '2-Part Dietary Supplement System · Two of Regulate, Detox, and Control', benefits = '["Helps support healthy metabolic function and blood sugar levels already within normal range*","Helps support healthy digestion and feelings of fullness*","Helps support liver health and digestive wellness*","Helps support healthy appetite for easier maintenance*","Helps support healthy energy levels*"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'What''s in the Stack', facts = '[{"name":"Regulate","detail":"Combines the power of Berberine, Bitter Melon, and Banaba Leaf to support sustainable weight management and metabolic health."},{"name":"Detox","detail":"Designed to support liver health, detoxification, and weight maintenance with Solarplast, Artichoke Leaf, Dandelion Leaf, Milk Thistle, Protease, and Lipase."},{"name":"Control","detail":"Crafted to help support appetite regulation, hormonal balance, and metabolism with African Mango, Raspberry Ketone, Green Coffee Bean, and Green Tea.**"}]'::jsonb, faqs = '[{"question":"Where can I get the Maintenance Stack?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'maintenance-stack-2' and tagline = '';

update public.billing_products set
  category = 'bundle', tagline = 'Long-Term Weight Maintenance',
  description = case when description = '' then 'The full Maintenance Stack (Regulate, Detox, and Control) paired with Detox for ongoing liver and digestive support after your weight management program.' else description end,
  format = 'Dietary Supplement System · Regulate + Detox + Control, plus Detox', benefits = '["Helps support healthy metabolic function and blood sugar levels already within normal range*","Helps support healthy digestion and feelings of fullness*","Helps support liver health and digestive wellness*","Helps support healthy appetite for easier maintenance*","Helps support healthy energy levels*"]'::jsonb, how_to_take = 'Take as directed on the label and by your THINNR provider.',
  facts_title = 'What''s in the Stack', facts = '[{"name":"Regulate","detail":"Combines the power of Berberine, Bitter Melon, and Banaba Leaf to support sustainable weight management and metabolic health."},{"name":"Detox","detail":"Designed to support liver health, detoxification, and weight maintenance with Solarplast, Artichoke Leaf, Dandelion Leaf, Milk Thistle, Protease, and Lipase."},{"name":"Control","detail":"Crafted to help support appetite regulation, hormonal balance, and metabolism with African Mango, Raspberry Ketone, Green Coffee Bean, and Green Tea.**"},{"name":"Detox (additional)","detail":"Thinnr Detox helps support your body''s natural detoxification processes. This formula helps support liver health and digestive wellness.**"}]'::jsonb, faqs = '[{"question":"Where can I get the Maintenance Stack?","answer":"Available through certified THINNR healthcare providers."},{"question":"Has the FDA evaluated these statements?","answer":"**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."}]'::jsonb, disclaimer = '**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.',
  offered_cadences_weeks = '{2,4,6,8,10,12}', default_cadence_weeks = 4
 where slug = 'maintenance-detox-stack' and tagline = '';

