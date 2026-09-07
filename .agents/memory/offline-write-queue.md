---
name: Offline patient write queue
description: Durable invariants of the mobile patient offline write queue — projection model, cached-snapshot launches, claim-first idempotency receipts, pinned photo uploads, account boundaries.
---

# Offline patient write queue

**Model.** One optimistic `state = project(base, queue)`; `base` is server truth plus acked
items. The queue item id doubles as the server `Idempotency-Key`. Drain is single-flight and
head-first: a retrying head blocks later writes; a permanent 4xx parks the item as failed and
lets the rest proceed. Acks never recompute from base (local undo-window removals must
survive); only discards and hydration recompute — that is where "server wins" happens.

**Why:** natural-key upserts made most replays safe, but lost responses on create routes and
out-of-order replays were the real duplication/reordering risks.

**Cached-snapshot launches.** An offline cold start opens on the last acked server snapshot
plus the queue with writes ALLOWED, but the base is flagged "from cache": the drain must
refresh live truth and reconcile BEFORE sending anything, or a queued edit of a row deleted
since the snapshot resurrects it. The account role is cached per auth user so the offline
cold start never lands in the write-blocked "couldn't load your account" state.

**Receipts are claimed first, never written after.** The server claims a `pending` receipt
row before applying the write and flips it to `done` with the stored answer afterwards. An
in-flight twin gets a retryable 503; a stale pending claim is taken over atomically; a
claim/lookup failure fails closed (502). **Why:** a best-effort receipt insert after the
write let "receipt failed + response lost" double-apply on replay. Any new patient write
route must go through the same helper, and the client must keep treating 503 as retryable.

**Photo uploads are pinned by a client upload id.** Presign/PUT/finalize is multi-step, so a
lost finalize response is indistinguishable from a failed upload. The upload id (queue photo
id, or `<session>.<angle>` for guided shots) deterministically names the object path, so a
retry overwrites and re-finalizes the same object instead of leaking an invisible second one.
Deferred guided shots must carry their id into the queued upload. Bytes never ride the queue
file (separate blob key); the item records `uploadedPath` before the grid write.

**Account boundaries.** Queue + snapshot stay on disk under the account's own keys across
sign-out; memory drops on epoch change; only that account's next sign-in loads them. Account
deletion wipes them. The demo persona has no queue and no connectivity/AppState triggers.
