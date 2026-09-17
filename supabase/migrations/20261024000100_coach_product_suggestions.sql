-- Coach product suggestions from the patient's own data.
--
-- Each catalog product carries HQ-editable suggestion rules
-- (`coach_suggestion`): which patient signals make the product worth
-- offering to the coach model, which signals block it outright
-- (contraindication flags), a phrasing hint, and whether the product's own
-- content covers lab markers (otherwise bloodwork-based nudges are phrased
-- as something to ask the provider about). The rule vocabulary is fixed in
-- the API server; the row only stores the chosen ids.
--
-- Per-patient suppression state rides the existing patient_flags row (no new
-- patient-owned table, so the identity write barrier and purge order are
-- untouched): the last time each product was suggested (keyed by catalog
-- slug) and whether the patient asked the coach to stop suggesting products.
--
-- Everything is additive.

alter table public.billing_products
  add column if not exists coach_suggestion jsonb not null default '{}'::jsonb;

alter table public.billing_products
  drop constraint if exists billing_products_coach_suggestion_check;
alter table public.billing_products
  add constraint billing_products_coach_suggestion_check
  check (jsonb_typeof(coach_suggestion) = 'object');

comment on column public.billing_products.coach_suggestion is
  'HQ-edited coach suggestion rule: {signals: text[], avoid_signals: text[], phrasing: text, bloodwork_covered: boolean}. Signal ids are validated by the API server.';

-- Seed the curated defaults for the bundled catalog (rows that HQ already
-- edited keep their own rule; only the empty default is filled in).
update public.billing_products set coach_suggestion = seed.rule
from (values
  ('boost', '{"signals":["glp1_medication"],"avoid_signals":[],"phrasing":"Only alongside a GLP-1 their provider prescribed; frame it as support for the plan they are already on, never a replacement.","bloodwork_covered":false}'::jsonb),
  ('control', '{"signals":["off_plan_meals","stall"],"avoid_signals":[],"phrasing":"Tie it to hunger, cravings, or snacking they actually described; a stall alone is not a reason unless appetite is part of it.","bloodwork_covered":false}'::jsonb),
  ('detox', '{"signals":["bloodwork_liver_high"],"avoid_signals":[],"phrasing":"Keep it about digestion and feeling less sluggish; never promise anything about lab values.","bloodwork_covered":false}'::jsonb),
  ('regulate', '{"signals":["bloodwork_glucose_high"],"avoid_signals":["diabetes_medication"],"phrasing":"Position it as blood sugar support worth raising with their provider, not a treatment for a lab result.","bloodwork_covered":false}'::jsonb),
  ('b-active', '{"signals":["bloodwork_b12_low"],"avoid_signals":[],"phrasing":"Connect it to energy and focus they mentioned; the lab flag is something for their provider to weigh in on.","bloodwork_covered":false}'::jsonb),
  ('creatine-plus', '{"signals":["low_protein"],"avoid_signals":["bloodwork_kidney_flag"],"phrasing":"Frame it as protecting lean mass while they lose, especially when protein is running low or they train.","bloodwork_covered":false}'::jsonb),
  ('maintenance-stack', '{"signals":["program_complete","weight_regain"],"avoid_signals":[],"phrasing":"For patients past the protocol who want to hold their results; lead with keeping the weight off, not starting over.","bloodwork_covered":false}'::jsonb)
) as seed(slug, rule)
where public.billing_products.slug = seed.slug
  and public.billing_products.coach_suggestion = '{}'::jsonb;

alter table public.patient_flags
  add column if not exists coach_product_suggestions jsonb not null default '{}'::jsonb,
  add column if not exists coach_product_opt_out boolean not null default false;

alter table public.patient_flags
  drop constraint if exists patient_flags_coach_product_suggestions_check;
alter table public.patient_flags
  add constraint patient_flags_coach_product_suggestions_check
  check (jsonb_typeof(coach_product_suggestions) = 'object');

comment on column public.patient_flags.coach_product_suggestions is
  'Catalog slug -> ISO timestamp of the last coach product card for that product; drives the repeat-suggestion window.';
comment on column public.patient_flags.coach_product_opt_out is
  'Patient asked the coach to stop suggesting products; cleared when they ask for suggestions again.';
