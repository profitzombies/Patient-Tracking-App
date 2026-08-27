---
name: Training video hosting
description: Patterns behind the hosted training-video stack — App Storage uploads, signed playback, and the SSE AI pipeline — and the invariants to preserve when extending it.
---

Lesson videos are hosted in Replit App Storage; the API server owns every storage interaction. Rules that must survive refactors:

- **DB stores object paths only, never signed URLs.** Playback/thumbnail URLs are minted per request (short-TTL signed GETs from the storage sidecar at 127.0.0.1:1106) so range requests hit storage directly — that is what makes `<video>` seeking work. Clients re-mint before expiry rather than caching URLs.
  **Why:** signed URLs expire and leak query-string credentials into the DB; paths stay stable across bucket/key rotation.
- **Uploads are presigned PUTs from the browser** (server issues URL + canonical object path under `/objects/training-videos/<videoId>/`), then a finalize call re-validates server-side: path prefix ownership, size cap, and an ffprobe playability probe (unplayable → 422 + object deleted). Never trust the client's claim that an upload is a video.
- **Replace/delete must clear derived artifacts in lockstep**: swapping or removing the file clears thumbnail + transcript rows and deletes the old storage objects. Entity delete flows remove the hosted file first and abort if that fails — otherwise objects orphan silently.
- **The AI pass is an SSE step pipeline** (transcribe → describe → chapters → thumbnail): each step persists its result the moment it lands (a later failure never rolls back earlier steps), failures surface as explicit step events with a retry that re-runs failed+skipped steps, and the stream must end with an explicit `done` event — client treats end-without-done as an error. A per-video in-memory mutex (409) stops concurrent runs.
- **Access is OPEN in the demo posture (Aug 2026 user decision — never re-add sign-in gates here).** Reaching the admin portal is enough: reads (playback, transcript) are unlimited; every write (upload, finalize, replace, remove, thumbnails, AI pass) rides a per-IP limiter with its own env knobs, the same shape as the knowledge library. A bearer is attached by signed-in clients but ignored server-side. Proof protocol when opening any surface: tokenless call succeeds, a `synthetic-staff-bearer` behaves identically, the limiter trips via X-Forwarded-For (trust proxy is on app-wide), and a drained IP can still read. Re-tightening is one middleware away. The SSE process route holds its limiter slot until stream close — that is the bound on concurrent AI runs.
- ffmpeg/ffprobe are nix system dependencies; audio is extracted server-side in 60s WAV chunks because the AI proxy transcribes audio only (no video input); chapter timestamps snap to chunk boundaries by design.
- Demo/demo-seed boundary: seeded lessons stay file-less; mobile carries the hosted-file columns for row parity but deliberately never streams.

**How to apply:** any new hosted-media surface (attachments, avatars, exports) should copy this shape — presign + finalize probe, paths-in-DB, per-request signed reads, derived-artifact lifecycle tied to the source file, SSE with explicit terminal event.

## Auto-thumbnail + dedicated bucket (Aug 2026)
- Finalize captures frame 0 as the thumbnail immediately (shared helper with the manual scrubber route); the AI thumbnail step runs only as a retry when that capture failed, and the client skips it when finalize returns a thumbnail.
- Any thumbnail persist re-reads the row first and drops the frame if video_source changed mid-capture — replaces/removals during slow captures must never stamp a stale cover.
- TRAINING_OBJECT_DIR (/<bucketId>/.private) routes ALL training media (upload minting + /objects/ resolution) to a dedicated bucket, falling back to PRIVATE_OBJECT_DIR. Stored paths carry no bucket name: flipping the knob while hosted files exist strands them in the old bucket — flip only at zero hosted files, or migrate objects first.
