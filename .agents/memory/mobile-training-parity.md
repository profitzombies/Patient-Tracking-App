---
name: Mobile training live-data port
description: The mobile Training tab is a verbatim port of the web training rules, locked in step by a dual-import parity suite; key assembly gotchas.
---

The mobile app's provider Training surface reads the LIVE Supabase training tables through the app's existing anonymous client and re-implements the web operations app's pure assembly/unlock/progress rules in a mobile-local module (`artifacts/thinnr-mobile/lib/training.ts`).

**Rule:** never let the two copies drift. The provider-training verification suite imports BOTH the mobile module and the web modules (`thinnr-operations/src/data/hq/training.ts`, `office-training.ts`) — they are pure TS, importable cross-artifact under tsx — and runs one shared fixture bundle through both, asserting byte-identical assembly plus hand-pinned values so both copies can't be wrong together. It is registered as the `provider-training` validation command.

**Why:** the web side is the source of truth for published/live filtering, sequential unlock, numbering, and team-progress math; a silent mobile drift would show different numbers on the phone than the office sees on the web for the same live rows.

**How to apply:** any change to the web training rules must be mirrored in the mobile module and the parity suite re-run. Assembly gotchas the suite pins:
- Numbering (`m.e[.v]`) counts ALL admin entries — draft modules, draft subgroups, and draft videos hold numbering slots — while `position` counts published items only. A published lesson after a draft subgroup skips numbers (e.g. `2.6` with no visible `2.4`/`2.5`).
- Root videos and subgroups share one entry-position space per module; position ties break video-first.
- Demo (unscoped) persona uses an empty completion map → frontier 0: first sequential lesson + all free-unlock items available, everything else locked; lesson deep links must resolve availability server-of-truth style, not trust navigation state.
- Team stats: roster = viewers with a non-null accountId; avgPct is the rounded mean of per-member rounded pcts; watch-seconds and completions intersect with the published order (rows for unpublished videos are ignored).
