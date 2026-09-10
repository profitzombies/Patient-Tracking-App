# Coach conversations and memory contract

This extension applies only to patient AI Coach conversations. Human Care Team
and AI Support retain their existing ownership, uniqueness, and workflows.

## Patient API

All paths below are under `/api`, require patient authorization, and return
private/no-store responses. Identity is derived from the bearer, never a body ID.

- `GET /patient-coach/conversations?archived=false&limit=20&offset=0`
  returns `{ conversations: CoachConversation[], total, nextOffset: number|null }`.
- `POST /patient-coach/conversations` with `{ clientKey: string }` idempotently
  creates a conversation and returns `{ conversation }`. Clients call this only
  on the first substantive send, not when opening an empty composer.
- `GET /patient-coach/conversations/:conversationId?before=&limit=100&today=`
  returns `{ conversation, messages, nextBefore: number|null, patient:
  { firstName, programDay } }`. Messages use the existing finalized wire shape,
  adding `seq` and `createdAt`. Pages are chronological; `before` is exclusive.
- `POST /patient-coach/conversations/:conversationId/messages` with
  `{ messages: ChatWireMessage[] }` retains signature-based idempotent upserts
  and original ordering/timestamps. Returns `{ ok: true }`.
- `PATCH /patient-coach/conversations/:conversationId` with
  `{ archived: boolean, expectedVersion: number }` returns `{ conversation }`.
  Archived conversations reject appends and generation until restored.
- `POST /patient-coach/conversations/:conversationId/retry-processing` retries
  failed bounded metadata work and returns `{ ok: true }`.
- `GET /patient-coach/memories?limit=20&offset=0` returns
  `{ memories: CoachMemory[], total, nextOffset: number|null }` (active and pending).
- `PATCH /patient-coach/memories/:memoryId` with
  `{ action: 'approve'|'decline'|'forget'|'correct', expectedVersion: number,
  text?: string }` returns `{ memory: CoachMemory }`.

`CoachConversation`:
`{ id, title, titleState: 'pending'|'ready'|'failed', archivedAt: string|null,
createdAt, updatedAt, version: number, processingState: 'pending'|'ready'|'failed' }`.
Fallback title is "New conversation". Migrated single history is
"Earlier conversation" without replacing its identity or messages.

`CoachMemory`:
`{ id, text, category, sensitivity: 'ordinary'|'sensitive',
state: 'active'|'pending'|'declined'|'removed'|'superseded',
sourceConversationId, sourceMessageId, sourceCreatedAt,
createdAt, updatedAt, confirmedAt: string|null, version: number }`.

Coach generation accepts optional `conversationId`, authorized before streaming.
No ID uses only a deterministic legacy compatibility conversation, never the
newest or an arbitrary patient conversation.

## Provider read API

- `GET /office/patients/:patientId/coach-conversations?office=&limit=20&offset=0`
  returns `{ conversations, total, nextOffset }` including archived.
- `GET /office/patients/:patientId/coach-conversations/:conversationId?office=&before=&limit=100`
  returns the same paginated conversation detail (patient greeting facts optional).
- `GET /office/patients/:patientId/coach-memories?office=&limit=20&offset=0`
  returns active approved `{ memories, total, nextOffset }` only.

Use existing office/clinical/lock/HQ-department gates on every provider endpoint.
Sources open these same authorized transcript endpoints, not public links.
Existing staff conversation summaries add `title` and `archivedAt`.

## Implementation boundaries

- Conversation storage/API owner: conversation migration, patient and provider
  conversation routes, existing legacy compatibility, staff summary fields,
  OpenAPI and codegen for ALL endpoints/types above.
- Memory owner: separate memory migration after conversation migration,
  memory patient/provider routes, bounded extraction/title processing through
  the existing job ledger, recall, generation authorization and integration.
- Mobile state owner: account API seam, CoachChatContext, coach-chat renderer
  and context-specific entry points; expose history methods to screens.
- Patient screen owner: new `coach-history` and `coach-memories` screens.
- Provider UI owner: web and mobile read-only provider panels and web AI list.
- Integrator: privacy/export/retention/reconciliation seams and setup,
  integrated verification.

Memory/title SQL and backend integration details must be agreed between owners
before dependent code is finalized. No private text in logs, audit, or analytics.