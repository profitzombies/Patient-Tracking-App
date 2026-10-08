---
name: Training video hosting
description: Patterns behind the hosted training-video stack — App Storage uploads, signed playback, and the SSE AI pipeline — and the invariants to preserve when extending it.
---

Lesson videos are hosted in Replit App Storage; the API server owns every storage interaction. Rules that must survive refactors:

- **DB stores object paths only, never signed URLs.** Playback/thumbnail URLs are minted per request (short-TTL signed GETs from the storage sidecar at 127.0.0.1:1106) so range requests hit storage directly — that is what makes `<video>` seeking work. Clients re-mint before expiry rather than caching URLs.
  **Why:** signed URLs expire and leak query-string credentials into the DB; paths stay stable across bucket/key rotation.
- **Uploads are presigned PUTs from the browser** (server issues URL + canonical object path under `/objects/training-videos/<videoId>/`), then a finalize call re-validates server-side: path prefix ownership, size cap, and an ffprobe playability probe (unplayable → 422 + object deleted). Never trust the client's claim that an upload is a video.
- **Replace/delete must clear derived artifacts in lockstep, object-first**: storage deletes are strict and idempotent (missing = already gone; refusal = abort, keeping the DB references as the retry handle), and references/transcript clear only AFTER the objects are gone — clearing references before a failed delete strands objects nothing points at.
- **The AI pass is an SSE step pipeline** (transcribe → describe → chapters → thumbnail): each step persists its result the moment it lands (a later failure never rolls back earlier steps), failures surface as explicit step events with a retry that re-runs failed+skipped steps, and the stream must end with an explicit `done` event — client treats end-without-done as an error. A per-video in-memory mutex (409) stops concurrent runs.
- **Writes need an HQ sign-in (Oct 2026 user decision, superseding the Aug 2026 "open demo posture / never re-add gates" rule).** A router-level gate requires an HQ account with `content_manage` for every write and every administrative read, and fails closed before any storage or database work. Only the learner delivery reads stay open (playback URLs, transcript, attachment download link), because share-link learners have no staff login. The per-IP write limiter stays as a second line; the SSE process route holds its slot until stream close, which bounds concurrent AI runs. Proof protocol: tokenless and `synthetic-staff-bearer` reads both answer 200/404, a tokenless upload-url mint gets 401, the synthetic bearer 401/403, and an invalid-body process call gets 401 (the gate runs before validation). Live probes must stay harmless (mints, invalid bodies) — never a DELETE, which would destroy a lesson file if the gate ever regressed.
- ffmpeg/ffprobe are nix system dependencies; audio is extracted server-side in 60s WAV chunks because the AI proxy transcribes audio only (no video input); chapter timestamps snap to chunk boundaries by design.
- Demo/demo-seed boundary: seeded lessons stay file-less; mobile carries the hosted-file columns for row parity but deliberately never streams.

**How to apply:** any new hosted-media surface (attachments, avatars, exports) should copy this shape — presign + finalize probe, paths-in-DB, per-request signed reads, derived-artifact lifecycle tied to the source file, SSE with explicit terminal event.

## Lesson attachments
- Attachments copy the video hosting shape in their own storage prefix; the real filename is stamped as object Content-Disposition at finalize, because the signer takes no per-request response overrides.
- **Why server-written only:** attachment row entries change via compare-and-swap endpoints, never the editor's draft save — a stale draft must not clobber a concurrent upload. Legacy name-only entries render an inert "No file" state on every surface, never a clickable dead end.
- **Delete rule:** same object-first contract as videos. Every row-delete entry point — including flows whose row cascades delete lesson rows implicitly — must run the one shared media purge before any row goes; purge failure keeps the rows.

## Auto-thumbnail + dedicated bucket (Aug 2026)
- Finalize captures frame 0 as the thumbnail immediately (shared helper with the manual scrubber route); the AI thumbnail step runs only as a retry when that capture failed, and the client skips it when finalize returns a thumbnail.
- Any thumbnail persist re-reads the row first and drops the frame if video_source changed mid-capture — replaces/removals during slow captures must never stamp a stale cover.
- TRAINING_OBJECT_DIR (/<bucketId>/.private) routes ALL training media (upload minting + /objects/ resolution) to a dedicated bucket, falling back to PRIVATE_OBJECT_DIR. Stored paths carry no bucket name: flipping the knob while hosted files exist strands them in the old bucket — flip only at zero hosted files, or migrate objects first.

**Replacement paths & the cleanup ledger:** a replace must keep the NEW reference valid, so displaced-object deletes can never fail the request — displaced paths are PRE-registered in a service-role-only cleanup ledger before the reference swap (ledger outage = abort with nothing mutated), settled after commit, and drained reference-aware by later writes (a row whose video still references its path is a stale pre-registration: drop the row, never the object). Strays are deleted-or-queued; if storage AND ledger both fail the response is 5xx — never success without a durable handle.
