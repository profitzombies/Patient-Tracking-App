-- Browser-role grant hardening (security audit, 2026-10-16).
--
-- Nothing here changes what the app can do. Every statement removes a
-- privilege that Row Level Security already made unusable, or pins a search
-- path on a function that touches no tables. The point is defence in depth:
-- a future permissive policy, or RLS switched off on one of these tables by
-- mistake, must not hand the public (anon) or signed-in (authenticated) API
-- roles a write path. The API server keeps working through the service role,
-- which these grants never governed.
--
-- 1. Pin search_path on the three food-catalog helpers the Supabase security
--    advisor flags as mutable. They are pure text/jsonb functions (no table or
--    extension references), so an empty search path cannot break them.
alter function public.food_catalog_identity_query(text) set search_path = '';
alter function public.food_catalog_variant_form_matches(text, jsonb) set search_path = '';
alter function public.food_catalog_variant_explicit_constraints_match(text, jsonb, text) set search_path = '';

-- 2. Tables created with the default grants but no browser-role policy at all:
--    service-role only, so the browser roles lose every privilege.
revoke all on table
  public.barcode_nutrition_facts,
  public.billing_carts,
  public.billing_prebuilt_carts,
  public.billing_shipments
from anon, authenticated;

-- 3. Tables whose policies only ever name signed-in HQ staff: anon loses
--    everything; authenticated keeps exactly what its policies can exercise.
revoke all on table public.knowledge_documents from anon;
revoke all on table public.training_video_transcripts from anon;
revoke insert, update, delete, references, trigger, truncate
  on table public.training_video_transcripts from authenticated;

-- 4. Training learner tables are reached only through the SECURITY DEFINER
--    learner RPCs (the anonymous demo-roster policies were dropped earlier),
--    so anon needs no direct privilege. Course content stays anon-readable
--    through its SELECT policies; only the never-usable extras go.
revoke all on table
  public.training_completions,
  public.training_invites,
  public.training_viewers
from anon;
revoke references, trigger, truncate on table
  public.training_courses,
  public.training_modules,
  public.training_subgroups,
  public.training_videos
from anon;

-- 5. Housekeeping: privileges no policy can ever exercise.
revoke references, trigger, truncate on table public.profiles from authenticated;
