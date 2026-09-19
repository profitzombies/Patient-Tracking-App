---
name: Patient edit history (append-only amendments)
description: How prior values survive staff/patient record corrections alongside the PII-free audit ledger; write seams, actor model, and testing traps.
---

**Rule:** the audit ledger stays PII-free; prior/new VALUES live in a separate patient-owned append-only history table written right after the audit call in the same request, storing the audit event id the audit RPC now returns. Never put values into audit metadata.

**Why:** HIPAA amendments must append, not overwrite; the audit ledger was deliberately built to record which field changed, not what it was.

**How to apply:**
- Every route that edits a shared record family (profile, status, staff weight, measurement visit, medication, provider note) pairs audit + history through one helper; a new edit route must go through that helper or the family silently loses its trail. Deletes record the removed values (new = null); updates record only fields that actually changed (arrays compared by JSON).
- Patient-made edits to the same families write rows with actor kind `patient`, no actor name, no audit id. There is no patient measurement edit route, so measurements are staff-only history by design.
- History write is best-effort after audit (not one transaction): a history RPC failure logs, the edit still lands. If a true transactional guarantee is ever required, fold the history insert into the edit RPCs.
- Read route allows locked offices (read-only compliance view); HQ drill-in must send `?office=`. The web tab lives in the shared live patient page, so office and HQ get it from one component.
- Live proof recipe: PostgREST call of the read RPC with the service key (200 `[]`) and anon key (401), plus the write RPC with an unknown uuid (`unknown patient` P0001) proves the recreated functions and their guards without touching data. Expect a `rls_enabled_no_policy` INFO advisor like every other service-role-only patient table.
- Web RTR suite reuses the record-export tsconfig (same Radix stubs); the history query only mounts once the History tab is chosen, so sibling suites whose fetch stubs throw on unknown URLs are unaffected.
