---
name: Coach conversation titles and patient rename
description: How coach chat history names are generated and how a patient rename keeps precedence over the server title job; late-read reconciliation on the mobile client.
---

Rule: the server title job writes any clean model title (1–40 chars) but must never overwrite a row whose `title_source` is `patient`; the rename RPC sets that source and bumps `version`. One PATCH route carries two intents (archive OR rename) as a union body, never both.

**Why:** an earlier design forced titles into a five-value allowlist, so every chat read "New conversation". Once titles are model-written, the job and a patient rename race on the same row; the source column decides it in SQL, not in the worker.

**How to apply:**
- Titles pass the coach voice rules (no dashes, brand guard) AND a deterministic sensitive-text screen (health numbers with units, doses, %, contact details, long digit runs) → keyword fallback. Never log the raw model reply.
- Demo account names conversations on the device from the first message with a word-picking heuristic; a local renamed-set keeps auto-naming off patient-named demo rows.
- Mobile keeps a committed-rows map (id → newest confirmed row) and reconciles late list/detail reads against it: older version → replaced, archived-mismatch → dropped. Deleting cache entries alone is not enough because in-flight reads re-cache the old row.
- Applied-migration checksums: a comment-only edit to an already-applied migration breaks the apply script; verify the live function body matches, then re-record the checksum rather than editing history.
