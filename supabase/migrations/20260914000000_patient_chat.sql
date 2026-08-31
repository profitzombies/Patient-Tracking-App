-- THINNR per-patient chat persistence — coach and support conversations.
--
-- Coach chat used to be session-only: the transcript lived in app memory and
-- the server kept nothing (it replays a bounded history window the client
-- sends with each request). These tables give every signed-in patient a
-- durable transcript per thread ("coach" and the patient support thread), so
-- closing or reinstalling the app resumes the conversation exactly where it
-- left off. The DEMO persona keeps its in-memory-only behavior and never
-- touches these tables.
--
-- Message rows capture the CLIENT's on-screen message shape, not the model
-- wire shape: the revealed text exactly as the patient saw it (paced-reveal
-- and stop contracts mean text is finalized before it is stored), the
-- stopped flag for interrupted replies, the rich card payload, the curated
-- one-tap reply labels, reply linkage, the hidden flag (a greeting a photo
-- hid), and a stored patient-media reference for chat photos. `client_id` is
-- the client-generated message id — upserts on (conversation_id, client_id)
-- make appends idempotent and let later card-state updates (a food card
-- marked added, a rename) re-store the same message.
--
-- `seq` is an identity column: it orders messages by insert order within a
-- batch and across batches, so the transcript reads back in exactly the
-- order rows were first stored (client batches arrive in thread order).
--
-- These are CLEAN NEW tables: the legacy pre-reset chat shapes (messages,
-- ai_conversation_logs, ...) exist only in the archive schema and are
-- deliberately not reused.
--
-- RLS: enabled with NO policies on purpose, and privileges revoked from
-- anon/authenticated. Only the API server's service role (which bypasses
-- RLS) reads or writes; the mobile app always goes through
-- /api/patient-chat/* with a bearer session token. Do not add
-- anon/authenticated policies here.
--
-- Safe to re-run: guarded with IF NOT EXISTS / CREATE OR REPLACE.

-- ── Conversations ───────────────────────────────────────────────────────────

create table if not exists public.patient_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Which chat surface this thread is: the patient coach chat or the
  -- patient's AI support thread. One row per patient per thread.
  thread text not null
    check (thread in ('coach', 'support')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (patient_id, thread)
);

comment on table public.patient_chat_conversations is
  'One durable conversation per patient per chat thread (coach / support). Written and read solely by the API server via the service role; RLS is enabled with no policies by design.';

alter table public.patient_chat_conversations enable row level security;
revoke all on public.patient_chat_conversations from anon, authenticated;

-- ── Messages ────────────────────────────────────────────────────────────────

create table if not exists public.patient_chat_messages (
  conversation_id uuid not null
    references public.patient_chat_conversations(id) on delete cascade,
  -- Client-generated message id (e.g. "coach-greeting", "coach-m3f...-4");
  -- opaque to the server. Unique per conversation so appends are idempotent.
  client_id text not null
    check (client_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- Insert-order sequence for reading the transcript back in thread order.
  seq bigint generated always as identity,
  role text not null
    check (role in ('user', 'assistant')),
  -- The on-screen text exactly as the patient saw it (revealed text for
  -- assistant replies). May be empty for a stopped reply kept only for its
  -- card. Generous cap: support replies are long-form markdown.
  text text not null default ''
    check (char_length(text) <= 40000),
  -- The patient stopped this reply mid-stream; the kept text is a fragment.
  stopped boolean not null default false,
  -- Rendered nowhere but still replayed to the model (photo-hidden greeting).
  hidden boolean not null default false,
  -- Rich card attached to an assistant reply ({kind, payload}), stored as
  -- the client received it. Size is validated at the API layer.
  card jsonb
    check (card is null or jsonb_typeof(card) = 'object'),
  -- Server-curated one-tap reply labels (array of short strings).
  quick_replies jsonb
    check (quick_replies is null or jsonb_typeof(quick_replies) = 'array'),
  -- Assistant messages: client id of the user message this reply answers.
  reply_to_client_id text
    check (reply_to_client_id is null
      or reply_to_client_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- Chat photo reference: { path, width, height, kind?, mealSlot?, reused? }
  -- where path is the patient-media object path of the stored copy. The API
  -- layer validates the path lies under the owning patient's prefix.
  photo jsonb
    check (photo is null or jsonb_typeof(photo) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, client_id)
);

create index if not exists patient_chat_messages_by_seq
  on public.patient_chat_messages (conversation_id, seq);

comment on table public.patient_chat_messages is
  'Durable chat messages in the client''s on-screen shape (revealed text, stopped flag, card, quick replies, reply linkage, stored photo reference). Service-role only; RLS enabled with no policies by design.';

alter table public.patient_chat_messages enable row level security;
revoke all on public.patient_chat_messages from anon, authenticated;

-- ── Atomic apply ────────────────────────────────────────────────────────────
--
-- One client append batch = ensure the conversation row exists + upsert the
-- finalized messages, in ONE transaction. Upserts merge on
-- (conversation_id, client_id): a re-sent message (outbox retry) lands once,
-- and a card-state update (food card marked added, a rename) overwrites the
-- stored copy wholesale — the client always sends the full message shape.
-- `seq` and created_at are preserved on conflict so updates never reorder
-- the transcript.
--
-- Service-role only, like the tables: EXECUTE revoked from anon and
-- authenticated. SECURITY INVOKER on purpose — the service role bypasses
-- RLS itself; no definer escalation to hand out.

create or replace function public.patient_chat_apply(
  p_patient_id uuid,
  p_thread text,
  p_messages jsonb default '[]'::jsonb
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_conversation_id uuid;
begin
  if p_thread not in ('coach', 'support') then
    raise exception 'invalid thread %', p_thread;
  end if;

  insert into public.patient_chat_conversations (patient_id, thread)
  values (p_patient_id, p_thread)
  on conflict (patient_id, thread) do update set updated_at = clock_timestamp()
  returning id into v_conversation_id;

  insert into public.patient_chat_messages
    (conversation_id, client_id, role, text, stopped, hidden, card,
     quick_replies, reply_to_client_id, photo, created_at, updated_at)
  select
    v_conversation_id,
    r.client_id,
    r.role,
    coalesce(r.text, ''),
    coalesce(r.stopped, false),
    coalesce(r.hidden, false),
    r.card,
    r.quick_replies,
    r.reply_to_client_id,
    r.photo,
    clock_timestamp(),
    clock_timestamp()
  from jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb)) as r(
    client_id text, role text, text text, stopped boolean, hidden boolean,
    card jsonb, quick_replies jsonb, reply_to_client_id text, photo jsonb
  )
  on conflict (conversation_id, client_id) do update set
    text = excluded.text,
    stopped = excluded.stopped,
    hidden = excluded.hidden,
    card = excluded.card,
    quick_replies = excluded.quick_replies,
    reply_to_client_id = excluded.reply_to_client_id,
    photo = excluded.photo,
    updated_at = clock_timestamp();
end;
$$;

revoke all on function public.patient_chat_apply(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.patient_chat_apply(uuid, text, jsonb)
  to service_role;

-- ── Chat photos in the media ledger ─────────────────────────────────────────
--
-- Chat photo copies ride the existing patient-media rail (upload-url →
-- presigned PUT → finalize) with their own object kind, so the ledger can
-- tell a chat photo from library photos. Widen the ledger's kind check.

alter table public.patient_media drop constraint if exists patient_media_kind_check;
alter table public.patient_media add constraint patient_media_kind_check
  check (kind in ('food', 'recipe', 'chat'));
