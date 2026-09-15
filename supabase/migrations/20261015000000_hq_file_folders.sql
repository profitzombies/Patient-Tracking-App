create table if not exists public.hq_file_folders (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 120 and name !~ '[\x00-\x1f/\\]'),
  parent_id uuid references public.hq_file_folders(id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hq_file_folders_sibling_name_idx
  on public.hq_file_folders (
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );
create index if not exists hq_file_folders_parent_idx
  on public.hq_file_folders(parent_id);

alter table public.hq_file_folders enable row level security;
revoke all on public.hq_file_folders from public, anon, authenticated;
grant all on public.hq_file_folders to service_role;

alter table public.hq_private_files
  add column if not exists folder_id uuid references public.hq_file_folders(id) on delete restrict,
  add column if not exists original_size_bytes bigint
    check (original_size_bytes is null or original_size_bytes >= size_bytes),
  add column if not exists compressed_at timestamptz;

create index if not exists hq_private_files_folder_created_idx
  on public.hq_private_files(folder_id, created_at desc);