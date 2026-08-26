-- THINNR AI Support knowledge base — uploaded documents whose extracted text
-- becomes the knowledge source for the provider AI Support chat.
--
-- HQ admins upload PDF / Word / text files from the admin portal. The API
-- server mints the presigned upload, verifies the object in App Storage,
-- extracts the full text server-side, and stores it here together with a
-- short summary + keyword list used later for answer routing. The table
-- stores App Storage object PATHS (`/objects/knowledge-docs/<documentId>/…`),
-- never signed URLs — those are minted per request by the API server.
--
-- RLS: HQ admins manage rows (the admin portal UI), the API server acts with
-- the service role (bypasses RLS) after verifying the caller's own staff
-- session, and anonymous access is denied entirely — knowledge content is
-- real program material, not demo data.
--
-- Safe to re-run: IF NOT EXISTS everywhere, policies/triggers dropped and
-- recreated.

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  -- Display name in the library — starts as the file name sans extension,
  -- renameable any time without touching the stored file.
  title text not null,
  original_filename text not null,
  -- App Storage object path of the CURRENT stored file. Replacing the file
  -- swaps this in one conditional write and deletes the old object.
  object_path text not null,
  content_type text not null,
  size_bytes bigint not null default 0,
  -- uploaded → extracting → ready | failed. Retry re-enters extracting.
  status text not null default 'uploaded'
    check (status in ('uploaded', 'extracting', 'ready', 'failed')),
  -- Plain-words reason when status = 'failed' (for example a scanned PDF
  -- with no text layer). A failed document is never silently empty.
  error_message text,
  -- Full extracted text — the AI Support chat's knowledge source. Null until
  -- extraction succeeds; cleared when the file is replaced.
  extracted_text text,
  extracted_chars integer not null default 0,
  -- Short routing aids written at extraction time (answer routing picks
  -- documents by these before quoting extracted_text).
  summary text,
  keywords jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.knowledge_documents is
  'AI Support knowledge library: HQ-uploaded documents (PDF/Word/text) whose server-extracted text grounds the provider AI Support chat. Object paths only — signed URLs are minted per request by the API server.';

comment on column public.knowledge_documents.object_path is
  'App Storage object path of the stored file (/objects/knowledge-docs/<documentId>/<objectId>). Written only by the API server after a verified HQ-admin upload; never a signed URL.';

comment on column public.knowledge_documents.extracted_text is
  'Full text extracted server-side from the stored file. Null until status = ready; cleared when the file is replaced so stale text never describes a new upload.';

drop trigger if exists set_knowledge_documents_updated_at on public.knowledge_documents;
create trigger set_knowledge_documents_updated_at
  before update on public.knowledge_documents
  for each row execute procedure public.set_thinnr_training_updated_at();

alter table public.knowledge_documents enable row level security;

-- HQ admins manage the library from the admin portal (list, preview, rename;
-- storage-touching writes go through the API server, which re-verifies the
-- caller's session and uses the service role). No anon policies exist, so
-- anonymous access is denied outright.
drop policy if exists "HQ admins manage knowledge documents" on public.knowledge_documents;
create policy "HQ admins manage knowledge documents"
  on public.knowledge_documents
  for all
  to authenticated
  using (private.is_hq_admin())
  with check (private.is_hq_admin());
