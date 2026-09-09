# Care Team Messaging API Contract

All endpoints require a bearer session. IDs are UUIDs, timestamps are ISO-8601, and sequence
numbers are positive integers. Error responses are `{ error: string }`; scope misses use a
neutral 404. Care-team messages are plain text only.

## Patient

`GET /patient-care-team`

Returns `{ current: CareTeamConversation | null, retained: CareTeamConversation[] }`.
`current` belongs to the patient's current provider. `retained` contains prior-provider
threads, read-only and newest first.

`CareTeamConversation = { id, providerId, businessName, current, canSend, status,
unreadCount, lastMessageSeq, lastReadSeq, createdAt, updatedAt }`.

`POST /patient-care-team/start` with `{}` atomically gets or creates the current provider's
thread. Returns `{ conversation: CareTeamConversation, created: boolean }`.

`GET /patient-care-team/:id/messages?before=<seq>&after=<seq>&limit=50`

`before` and `after` are mutually exclusive; limit is 1..100. Returns
`{ conversation, messages: PatientCareTeamMessage[], nextBefore, nextAfter }`, ordered
oldest-to-newest. `PatientCareTeamMessage = { seq, clientId, sender:
"patient"|"care_team", text, createdAt }`. No employee identity is returned.

`POST /patient-care-team/:id/messages`

Body `{ clientId: string(1..64, [A-Za-z0-9._:-]), text: string(1..4000) }`. The server fixes
the sender as the authenticated patient. A repeated clientId with identical text returns the
existing message (`created:false`); reuse with different content returns 409. Returns
`{ message: PatientCareTeamMessage, created: boolean }`.

`POST /patient-care-team/:id/read`

Body `{ throughSeq: positive integer }`. Monotonically advances the patient's private read
high-water mark and returns `{ lastReadSeq, changed }`. Duplicate/lower reads are no-ops and
do not create duplicate audit events. Patient reads are never exposed as staff Seen receipts.

## Office

`POST /office/conversations/start` body `{ patientId }` atomically gets/creates that
patient's care-team thread for the caller's own office. HQ callers are forbidden. Returns
`{ conversation, created }`.

`GET /office/conversations` adds `channel=all|care_team|ai` (default `all`),
`patientId=<uuid>`, and `thread=coach|support|care_team`; existing status, assignee, unread,
search, sort, limit, and offset remain. Each summary adds `channel:
"care_team"|"ai"`, `providerId`, and `officeName`.

`GET /office/conversations/:id/events` accepts mutually exclusive `before`/`after`, limit
1..100, is polling-safe, and never changes read state. Returns ordered events plus
`nextBefore`/`nextAfter`.

`POST /office/conversations/:id/read` body `{ throughSeq }` explicitly advances the
per-staff marker and idempotently audits it.

Care-team replies use `POST /office/conversations/:id/reply` body
`{ clientId?: string, text }`. `clientId` is mandatory when the target is a human
care-team conversation and must be stable across retries; it remains optional only when
the target is a legacy AI conversation being redirected. Sender identity and office
ownership are server-derived. Calling reply on an AI conversation gets/creates the
matching care-team conversation and returns it; no new staff row is inserted into AI
history. Existing assign/status/notes are available to office staff on care-team threads.
All human-channel mutations reject HQ actors, including HQ actors using `?office=`.

## HQ

`GET /hq/conversations?office=<id>&patientId=<uuid>&channel=all|care_team|ai&thread=coach|support|care_team&status=...&assignee=...&unread=...&q=...&sort=...&limit=50&offset=0`

Returns `{ conversations, total, autoCloseDays }` across all active offices. Clinical
permission is required for care-team/coach; support permission covers support AI only.

`GET /hq/conversations/:id/events?before=&after=&limit=` and
`GET /hq/conversations/:id/notes` are read-only and permission-scoped.
`POST /hq/conversations/:id/read { throughSeq }` records only the HQ viewer's own read
high-water and idempotent metadata-only audit.

No HQ endpoint sends messages or mutates assignment, status, notes, or other human workflow.