# Coach memory handoff

## Dependency and schema

The memory migration is deliberately ordered after the conversation migration
(`20261008000000_coach_conversations.sql`) and extends the storage-owned
tables:

- `public.patient_chat_conversations(id, patient_id, thread='coach',
  archived_at, processing_state, version, ...)`
- `public.patient_chat_messages(conversation_id, client_id, seq, role, text,
  created_at, ...)`

`20261008010000_coach_memory.sql` adds `coach_memories` (whose source foreign
key is `(source_conversation_id, source_message_id)` into the existing
composite message primary key) and a durable
`coach_memory_source_suppressions` tombstone table.  Both are patient-owned and
the migration reruns `private.install_patient_identity_write_guards()`.

Export consumers should include memory fields `id, text, category,
 sensitivity, state, source_conversation_id, source_message_id,
 source_created_at, created_at, updated_at, confirmed_at, version`.
Suppressions must also export `source_conversation_id`: client message IDs are
only unique within a conversation. Their fields are
`source_conversation_id, source_message_id, topic_key, reason, created_at`.

## Queue semantics

Appending a substantive patient message should make its conversation's
`processing_state` pending. `coach_conversation_append` transactionally adds a
`kind='memory'` item to storage's single `coach_conversation_work` table. The
`coach-memory-processing` scheduled job claims only this durable work through
`coach_memory_claim_processing`, then completes/fails with the matching claim
token. A retry uses storage's `coach_conversation_enqueue_processing` rather
than processing inline. Claims are lease-bound and all completion/memory
mutations re-check the live conversation and patient identity in one SQL
transaction, so archive/delete/identity reconciliation cannot receive a late
write.

The memory migration assumes the storage work table has the lease shape
`id, patient_id, conversation_id, kind, source_client_id, state, lease_owner,
lease_until, attempts, last_error, created_at, updated_at`; this is the one shared queue
for both `memory` and `title` work. `coach_conversation_enqueue_processing`
must accept a `title` kind as well as `memory` and preserve its idempotency
under `(conversation_id, kind)`.

The provider identifier is `text` (not UUID) and memory RPCs are explicitly
granted only to `service_role` after revocation. Provider memory results are
active-only and verify that the originating composite transcript source still
matches its stored source hash. Memory rows retain an internal
`source_text_hash` and incremented `source_revision` for corrections; these
prevent a finalized-message edit or delayed work item from replacing the
newer corrected version.

The exact ordinary food-preference grammar accepts a terminal period or
exclamation mark (never a question mark), including explicit preferences for
vegetarian/vegan/quick/simple meals or recipes. Anything outside that narrow
grammar remains pending rather than being auto-promoted.

## Privacy/retrieval boundary

The memory worker uses only explicit patient text. Credential-like text is
categorically discarded. Ordinary facts from a narrow deterministic allowlist
may become active; sensitive or uncertain candidates are pending. Decline,
forget, correction, and supersession create source/topic suppression records.
Recall queries active memory versions only; it does not scan old transcripts as
a fallback. A suppression permanently blocks re-extraction and raw historical
source retrieval, not an intentional later active version. Accordingly, a
patient may explicitly approve a removed/declined memory or create a
replacement with correction/remember-again: that active version is eligible
for memory selection while the original transcript source remains blocked.
Superseded versions are never recalled. When (and only when) the patient
explicitly asks about a prior conversation, a separate exact-owner query may
return at most three relevant historical excerpts. It filters credentials,
sensitive terms, and every suppression source/topic before application code
sees text; an ambiguous reference receives a brief clarification request.
Generation is authorized for the exact conversation before recall and receives
bounded relevant snippets only.