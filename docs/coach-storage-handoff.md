# Coach conversation storage handoff

Conversation storage lands in `20261008000000_coach_conversations.sql` and
continues to use `public.patient_chat_conversations` and
`public.patient_chat_messages`; no new transcript table is introduced.

`CoachChatInput.conversationId` is optional in the canonical OpenAPI schema.
The generated `CoachChatBody` retains it, and `/api/coach/chat` reads this
parsed field to authorize a selected non-legacy conversation; raw request-body
fallbacks would bypass the contract and are not permitted.

## Conversation rows

Coach rows have `thread = 'coach'`. Their new columns are:

- `client_key` — nonempty opaque key, unique per patient for idempotent lazy
  creation;
- `title`, `title_state` (`pending`, `ready`, `failed`);
- `archived_at`;
- `version` — archive/restore optimistic-concurrency version;
- `processing_state` (`pending`, `ready`, `failed`).

The existing singleton coach row migrates in place as the deterministic legacy
compatibility conversation (`legacy_compat = true`, title `Earlier
conversation`). Its UUID, messages, client IDs, message sequences and
timestamps are not changed. New API conversations use `legacy_compat = false`.
AI support remains singleton, and care-team keeps its existing per-patient /
business uniqueness unchanged.

## Service-only SQL API

- `coach_conversation_create(patient_id, client_key)`
- `coach_conversation_list(patient_id, archived, limit, offset)`
- `coach_conversation_get(patient_id, conversation_id)`
- `coach_conversation_append(patient_id, conversation_id, messages)`
- `coach_conversation_archive(patient_id, conversation_id, archived,
  expected_version)`
- `coach_legacy_conversation_id(patient_id)`

All are service-role only. Each exact-owner operation checks
`conversation.patient_id = p_patient_id` in SQL, and append rejects archived
conversations. The migration reruns
`private.install_patient_identity_write_guards()` after adding the
patient-owned queue/table data.

## Memory owner hook

`coach_conversation_append` writes durable rows to
`public.coach_conversation_work` in the same transaction only for a newly
inserted, nonblank patient turn. This is the shared queue — do not create
`coach_memory_processing_queue`.

The exact queue shape is `id`, `patient_id`, `conversation_id`, `kind`
(`title` or `memory`), `dedupe_key`, `source_client_id`, `state`, `attempts`,
`lease_owner`, `lease_until`, `last_error`, `created_at`, and `updated_at`.
Rows are unique on `(conversation_id, dedupe_key)`. Append writes one
`kind='title', dedupe_key='title'` row and one
`kind='memory', dedupe_key='memory:' || source_client_id` row. The title row's
`source_client_id` is the first substantive newly stored patient message; this
is a client message ID, because `patient_chat_messages` has the stable
composite identity `(conversation_id, client_id)`, not a UUID message id.

Memory/title workers must claim/complete this durable work through the existing
job ledger rather than launching untracked async work. Memory source foreign
keys, if desired, must reference
`public.patient_chat_messages(conversation_id, client_id)` as a composite key,
and conversation foreign keys must reference
`public.patient_chat_conversations(id)`.

## Provider authorization

Provider review routes call `resolveOfficeScope` with
`hqPermission: 'conversation_clinical'` and `requireUnlocked: true`, then use
provider-scoped SQL lookup. This applies to every conversation and memory path,
including detail/source routes. The office scope covers office staff, office
locks, disabled offices, and HQ department permission checks.

Memory route implementation must use this same
`conversation_clinical`/`requireUnlocked: true` gate (not `provider_read` and
not a lock-bypassing provider read), and memory SQL should take `provider_id
text` to match `patients.provider_id`.