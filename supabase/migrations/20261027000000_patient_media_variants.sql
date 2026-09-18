-- Photo display variants on the patient media ledger.
--
-- Progress and chat photos get two derived siblings in object storage
-- (<path>.thumb at 320 px, <path>.medium at 1024 px). The ledger row records
-- WHICH variants exist so reads can pick a size and fall back to the
-- original honestly, and so the backfill job can find photos still missing
-- theirs. Originals and every other column are untouched.
--
--   variants               the variant names present in storage ('thumb',
--                          'medium'); empty until generated
--   variants_attempted_at  last generation attempt (success or failure) so
--                          the backfill retries failures on a schedule
--                          instead of every run

alter table public.patient_media
  add column if not exists variants text[] not null default '{}'::text[],
  add column if not exists variants_attempted_at timestamptz;

alter table public.patient_media
  drop constraint if exists patient_media_variants_check;
alter table public.patient_media
  add constraint patient_media_variants_check
  check (variants <@ array['thumb', 'medium']::text[]);

-- The backfill's work queue: variant-eligible rows still missing a variant.
create index if not exists patient_media_variants_pending_idx
  on public.patient_media (object_path)
  where kind in ('progress', 'chat')
    and object_missing_at is null
    and not (variants @> array['thumb', 'medium']::text[]);
