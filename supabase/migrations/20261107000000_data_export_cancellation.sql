-- Staff can cancel a record export that is still building.
--
--   * `cancelled` joins the status set as a terminal state (like failed):
--     the row keeps its audit trail but owns no files.
--   * `cancel_requested_at` is the cooperative flag for a RUNNING job: the
--     route stamps it, the worker reads it between files/parts, removes
--     every part it already wrote, and flips the row to cancelled. A
--     queued job flips straight to cancelled (the claim RPC only takes
--     queued rows, so nothing ever runs it).
alter table public.data_exports
  add column if not exists cancel_requested_at timestamptz;

alter table public.data_exports drop constraint if exists data_exports_status_check;
alter table public.data_exports
  add constraint data_exports_status_check
  check (status in ('queued', 'running', 'ready', 'failed', 'expired', 'cancelled'));

comment on column public.data_exports.cancel_requested_at is
  'Set when the requester cancels a running export; the worker stops at the next file/part boundary, deletes written parts, and marks the row cancelled.';
