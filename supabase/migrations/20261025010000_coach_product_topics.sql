-- Coach product suggestions: conversation topics live with the catalog row.
--
-- The coach may bring a product up when the patient's latest message contains
-- one of the product's conversation phrases. Those phrases used to live only
-- in the app's bundled demo catalog, which meant HQ-created products could
-- never be matched and HQ edits never reached the live coach. They now ride
-- the same HQ-edited `coach_suggestion` rule as the account signals
-- (`topics`: text[] of lowercase phrases, matched as whole words).
--
-- Seed the curated phrases for the bundled products whose rule has no topics
-- yet; rows HQ already gave topics keep their own. Additive only.

update public.billing_products set coach_suggestion = coach_suggestion || jsonb_build_object('topics', seed.topics)
from (values
  ('boost', '["thinnr boost", "glp-1", "ozempic", "wegovy", "semaglutide", "tirzepatide", "mounjaro", "zepbound", "prescription weight loss", "weight loss injection", "weight loss injections", "weight loss shot"]'::jsonb),
  ('control', '["appetite", "hungry all the time", "always hungry", "snacking urges", "urge to snack", "portion control", "thinnr control"]'::jsonb),
  ('detox', '["detox", "liver", "bloated", "bloating", "water retention", "puffy", "sluggish digestion", "thinnr detox"]'::jsonb),
  ('regulate', '["blood sugar", "glucose", "sugar spikes", "sugar crash", "insulin resistance", "a1c", "berberine", "thinnr regulate"]'::jsonb),
  ('b-active', '["fatigue", "low energy", "no energy", "exhausted", "energy levels", "brain fog", "b vitamins", "vitamin b", "b12", "b-active", "feeling tired", "so tired", "tired all the time", "tired lately", "sluggish"]'::jsonb),
  ('creatine-plus', '["muscle", "muscles", "lifting", "lift weights", "weight training", "strength training", "gym", "workout", "workouts", "working out", "work out", "creatine", "lean mass", "toned", "tone up", "strength", "post workout recovery", "hmb"]'::jsonb),
  ('fiber', '["constipation", "constipated", "irregular", "regularity", "fiber", "psyllium", "thinnr fiber"]'::jsonb),
  ('maintenance-stack', '["maintenance stack", "keep the weight off", "keeping the weight off", "keep my weight off", "keep it off", "maintain my weight", "maintain my results", "after the program ends", "finished the program", "program is over", "regain", "gaining it back", "gained some back", "stay at this weight"]'::jsonb)
) as seed(slug, topics)
where public.billing_products.slug = seed.slug
  and not (public.billing_products.coach_suggestion ? 'topics');

comment on column public.billing_products.coach_suggestion is
  'HQ-edited coach suggestion rule: {signals: text[], avoid_signals: text[], phrasing: text, bloodwork_covered: boolean, topics: text[]}. Signal ids are validated by the API server; topics are lowercase conversation phrases matched as whole words.';
