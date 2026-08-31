---
name: Per-account chat persistence
description: Pattern for persisting session-held chat threads (coach/support) to a signed-in account without touching demo behavior — outbox, hydration, photos, and the effect-ordering trap.
---

Chat threads persist per account via append/load endpoints (`/patient-chat/:thread`), while the demo persona stays 100% in-memory. The pattern:

- **Finalized-only, signature-diffed outbox.** A persistence effect walks `messages`, serializes each `status === 'done'` message to its wire shape, and enqueues any whose JSON signature differs from the last persisted signature for that id. Streaming and error bubbles never match `done`, so they never persist; later mutations of a stored turn (card update, hidden flip, photo path landing) re-upsert the same client id. The server RPC upserts by (conversation, client_id) preserving original seq, so re-upserts never reorder.
- **Hydration seeds the baselines.** On open, loaded rows write their signatures into the persisted map BEFORE rendering, so restored history never re-enqueues. Mark the thread hydrated before any early return (empty threads included) — persistence is gated on hydration so nothing writes into a transcript that was never read. Demo accounts never hydrate, hence never persist.
- **Effect-ordering trap (caused a real bug):** if the flush looks up messages via a `messagesRef`, the ref-sync effect MUST be declared before the persistence effect. Declared after, the flush sees last render's array, finds the just-finalized reply still `streaming`, and silently drops it from the outbox — user turns land (re-enqueued by later renders), final replies vanish. Symptom: store holds the user turn but never the reply.
- **Photo rule:** only session-local capture URIs re-attach to requests or upload (`!/^https?:/` — data:, file:, blob:, ph:, content:). Hydrated bubbles hold the stored copy's https display URL and replay text-only per the request contract. Do NOT gate on `data:` only — suites and native flows use `file://` fixtures/URIs. In production every chat photo IS a data URI (photo-prep always base64-encodes), so the data-URI-only upload path covers all real captures; a failed upload persists the turn without its photo rather than blocking the transcript.
- **Ids:** real-account message ids carry a per-mount nonce (`coach-<nonce>-<n>`) so two sessions can't collide in the same conversation; demo keeps bare `coach-<n>` for byte-identical behavior. Stored client ids for numeric-id screens are minted per mount (`s<nonce>-<n>`) and mapped, never reused across mounts.

**Why:** the reveal/stop contract requires storing exactly what was on screen, only once final; demo suites diff request bytes, so any demo-path change (extra fields, different ids, network calls) is a regression.

**How to apply:** any new per-account thread (or making an existing session-held surface persistent) copies this shape: wire type + signature diff + hydrate-then-persist gating + local-URI photo rule. Verify with a restart-resume suite that asserts cards/chips/stopped flags/photos round-trip and that the demo section makes zero JSON API calls.
