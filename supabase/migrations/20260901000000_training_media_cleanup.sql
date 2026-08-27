-- Storage-cleanup ledger for hosted training media.
--
-- When a replace/displace flow strictly deletes an old storage object and
-- storage refuses, the request must still succeed — the new file is already
-- live and the row's reference must stay valid — so the refused object path
-- lands here as a durable retry handle instead. The API server drains this
-- table opportunistically on later training-media writes; a row leaves only
-- after storage confirms the object is gone.
create table if not exists public.training_media_cleanup (
  id uuid primary key default gen_random_uuid(),
  object_path text not null unique,
  video_id uuid,
  reason text not null default 'displaced',
  created_at timestamptz not null default now()
);

alter table public.training_media_cleanup enable row level security;

-- Service-role only: no policies, and no direct grants for API roles.
revoke all on table public.training_media_cleanup from anon, authenticated;
