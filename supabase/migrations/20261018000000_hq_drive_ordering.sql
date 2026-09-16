-- HQ file drive: manual ordering of folders and files.
-- position is null until an admin drags something in that folder; null rows
-- sort FIRST (files newest first, folders A-Z among themselves, the previous
-- defaults) so fresh uploads and new folders still land at the top of a
-- hand-ordered folder. Moving an item to another folder resets its position
-- so it also lands at the top there.
alter table public.hq_file_folders
  add column if not exists position integer null;
alter table public.hq_private_files
  add column if not exists position integer null;

create index if not exists hq_private_files_folder_position_idx
  on public.hq_private_files (folder_id, position, created_at desc)
  where archived_at is null;

-- One statement writes the whole order for one parent. Rows that are not
-- active children of p_parent_id are ignored, so the caller compares the
-- returned count with the ids it sent to detect a stale listing.
-- updated_at is deliberately untouched: file replacement uses it as its
-- compare-and-swap guard and a reorder must not make replacements fail.
create or replace function public.hq_reorder_drive_items(p_kind text, p_parent_id uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer := 0;
begin
  if p_kind = 'folders' then
    update public.hq_file_folders as f
       set position = o.ord - 1
      from unnest(p_ids) with ordinality as o(id, ord)
     where f.id = o.id
       and f.parent_id is not distinct from p_parent_id;
  elsif p_kind = 'files' then
    update public.hq_private_files as f
       set position = o.ord - 1
      from unnest(p_ids) with ordinality as o(id, ord)
     where f.id = o.id
       and f.folder_id is not distinct from p_parent_id
       and f.archived_at is null;
  else
    raise exception 'hq_reorder_drive_items: unknown kind %', p_kind;
  end if;
  get diagnostics updated = row_count;
  return updated;
end;
$$;

revoke all on function public.hq_reorder_drive_items(text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.hq_reorder_drive_items(text, uuid, uuid[]) to service_role;
