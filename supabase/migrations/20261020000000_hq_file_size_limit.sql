-- HQ file drive: raise the per-file storage cap from 50 MB to 250 MB.
-- 262144000 = 250 * 1024 * 1024 and matches MAX_HQ_FILE_BYTES on the API
-- server and the `size` maximum on the HQ file OpenAPI input schemas.
-- The original_size_bytes >= size_bytes check (hq_private_files_check1)
-- is untouched.
alter table public.hq_private_files
  drop constraint if exists hq_private_files_size_bytes_check;
alter table public.hq_private_files
  add constraint hq_private_files_size_bytes_check
  check (size_bytes between 1 and 262144000);
