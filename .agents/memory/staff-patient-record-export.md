---
name: Staff patient-record export
description: Right-of-access "Download full record" for one patient — shared archive builder, multi-part ZIPs, PDF summary, server-decided button visibility.
---

# Staff patient-record export

**Rule:** The staff copy of a patient's chart reuses the patient self-export
section builder with a staff-scoped caller; the only behavioural fork is the
media cap (patient self-export keeps its omission cap, the staff path splits
into numbered ZIP parts under a byte budget and lists every file in a
top-level manifest). Missing storage objects are counted and named in the
manifest, never silently skipped.

**Why:** Right-of-access requests must hand over the complete record; a
capped archive that drops photos or lab files is a compliance failure, and a
second archive builder would drift from the patient export content.

**How to apply:**
- Button visibility is a server decision: the client renders "Download full
  record" only when `GET /exports?patient=` lists the patient-record kind in
  `available`. There is no client-side office-role lookup — do not add one.
- HQ callers must send `office` (drill-in scope); office staff send null.
- Parts ride a jsonb column; `object_path` stays part 1 so the existing
  retention/cleanup job keeps working. Download URLs take `?part=N`
  (non-part jobs only accept 1). Every request and download is audited
  against the patient with the export id (+ part) in metadata.
- Exports panel hides `needsPatient` kinds from its request picker but still
  lists their jobs with progress and per-part downloads.
- Test seams: the RTR suite renders the real patient page; a global
  `document` stub wakes the Stripe loader — scope it to the download click.
  YAML flow-style values containing commas must be quoted or orval breaks.
- POST /exports sits behind the staff fresh-code gate; every web caller
  (panel and patient page) must request through the re-auth-aware office
  client, never the raw generated mutation hook, or the re-auth sheet cannot
  retry the request.
- pdfkit is externalized in the api-server esbuild config (it resolves font
  data relative to its own package); prove with `pnpm run build`.
