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
- **Auth rides the caller's existing Supabase session token** (server verifies via /auth/v1/user + profiles role, small TTL cache): hq_admin authors, hq_admin+provider_staff stream. No separate auth system, no cookie plumbing.
- ffmpeg/ffprobe are nix system dependencies; audio is extracted server-side in 60s WAV chunks because the AI proxy transcribes audio only (no video input); chapter timestamps snap to chunk boundaries by design.
- Demo/demo-seed boundary: seeded lessons stay file-less; mobile carries the hosted-file columns for row parity but deliberately never streams.

**How to apply:** any new hosted-media surface (attachments, avatars, exports) should copy this shape — presign + finalize probe, paths-in-DB, per-request signed reads, derived-artifact lifecycle tied to the source file, SSE with explicit terminal event.
