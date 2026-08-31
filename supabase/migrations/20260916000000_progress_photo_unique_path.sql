-- A stored object may back exactly ONE progress grid row per patient.
--
-- Two rows sharing an object_path would break the remove contract: the
-- atomic remove RPC drops grid rows + the media-ledger row and hands the
-- path back for byte deletion, so deleting either duplicate would silently
-- gut the survivor (a grid row pointing at deleted bytes). The photos
-- route rejects duplicates up front with a clear 400; this unique index is
-- the backstop that makes the invariant a database fact.
create unique index if not exists patient_progress_photos_object_path_key
  on public.patient_progress_photos (patient_id, object_path);
