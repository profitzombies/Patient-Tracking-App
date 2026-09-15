-- HQ file drive: archive state.
-- Archived files leave their folder listing but keep folder_id so a restore
-- puts them back (or at the root when that folder is gone). Folder deletion
-- still removes archived files inside the subtree.
alter table public.hq_private_files
  add column if not exists archived_at timestamptz null;

create index if not exists hq_private_files_archived_idx
  on public.hq_private_files (archived_at desc)
  where archived_at is not null;

-- Folder listings and searches only read active files.
create index if not exists hq_private_files_active_name_idx
  on public.hq_private_files (lower(name))
  where archived_at is null;
