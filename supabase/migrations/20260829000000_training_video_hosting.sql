-- THINNR training video hosting — real files arrive in App Storage.
--
-- The API server now hosts uploaded lesson videos in Replit App Storage and
-- runs an AI pass over each upload (timed transcript → description →
-- chapters → first-frame thumbnail). This migration is purely additive:
--
--   * `training_videos.video_source` (already present) starts being written:
--     it holds the App Storage object path (`/objects/training-videos/...`),
--     NEVER a signed URL — those are minted per request by the API server.
--   * `training_videos.thumbnail_source` — object path of the captured
--     thumbnail frame, or null to keep the typographic slide poster.
--   * `public.training_video_transcripts` — timed transcript segments, one
--     row per video. Kept OUT of `training_videos` on purpose: catalog rows
--     are intentionally anon-readable for the demo personas, but a full
--     transcript is the video's content, and watching requires a signed-in
--     staff session. RLS: HQ admins read (the editor's transcript viewer);
--     nobody writes from the client — only the API server's service role.
--
-- Safe to re-run: IF NOT EXISTS everywhere, policies/triggers dropped and
-- recreated.

-- ---------------------------------------------------------------------------
-- training_videos: thumbnail column + honest comments on the hosting slots
-- ---------------------------------------------------------------------------

alter table public.training_videos
  add column if not exists thumbnail_source text;

comment on column public.training_videos.video_source is
  'App Storage object path of the hosted video file (/objects/training-videos/<video>/<uuid>), or null when no file is uploaded. Written only by the API server after a verified HQ-admin upload; never a signed URL.';

comment on column public.training_videos.thumbnail_source is
  'App Storage object path of the thumbnail frame captured from the hosted video, or null to keep the typographic slide poster.';

-- ---------------------------------------------------------------------------
-- Timed transcripts (AI-generated, editable copy lives in the video row's
-- description/chapters — this is the raw timed text the pipeline works from)
-- ---------------------------------------------------------------------------

create table if not exists public.training_video_transcripts (
  video_id uuid primary key references public.training_videos(id) on delete cascade,
  -- [{"at": seconds, "end": seconds, "text": "..."}] in playback order.
  segments jsonb not null default '[]'::jsonb,
  -- BCP-47-ish language hint reported by the transcription model, if any.
  language text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.training_video_transcripts is
  'Timed transcript of a hosted training video, produced by the AI pipeline. Staff-only: catalog tables stay anon-readable for the demo, but transcript text is the video''s content.';

drop trigger if exists set_training_video_transcripts_updated_at on public.training_video_transcripts;
create trigger set_training_video_transcripts_updated_at
  before update on public.training_video_transcripts
  for each row execute procedure public.set_thinnr_training_updated_at();

alter table public.training_video_transcripts enable row level security;

-- HQ admins read transcripts in the editor's viewer. No client role can
-- write: rows are upserted by the API server (service role) after it
-- verifies the caller's own HQ-admin session token.
drop policy if exists "HQ admins read transcripts" on public.training_video_transcripts;
create policy "HQ admins read transcripts"
  on public.training_video_transcripts
  for select
  to authenticated
  using (private.is_hq_admin());
