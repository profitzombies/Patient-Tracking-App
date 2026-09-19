---
name: Staff inbox live stream
description: Architectural rules for the office/HQ conversation inbox live stream (server SSE over a shared change feed) and for the remaining polite pollers.
---

# Staff inbox live stream

**Rule 1 — the inbox never polls.** Each staff tab holds one authenticated
SSE stream (office and HQ scopes each have their own route). Every `ready`
frame, including the first, is a catch-up point: the client invalidates its
list/summary/newest-events queries exactly once. An explicit `end` frame
means "reconnect now"; a close without `end` means "back off, then reconnect".
**Why:** two requests every 5 s per tab scaled with staff headcount onto the
patient-serving API; the coach/support chats already streamed, so access rules
stay in the server (no Supabase Realtime).

**Rule 2 — one shared watcher, armed by the first subscriber only.** Change
detection is a process-wide feed: a single poller over the conversation
`updated_at` column plus in-process `poke()` after writes. Later subscribers
must not touch the timer; a stream of new tabs would otherwise postpone the
only database watcher indefinitely.

**Rule 3 — anything the watcher cannot see must announce itself.** Read
markers, notes and escalations live in side tables and never bump the
conversation row. Every route that writes one of them calls the feed's
`notify()` in-process, and the acting tab also invalidates its own list on
success. Cross-instance delivery of these side changes is a known gap
(follow-up proposed); do not bump `updated_at` for them, it drives sort order.

**Rule 4 — pushed events never re-key queries.** Streamed events merge into
component state under a separate "streamed through" watermark; read markers
use max(fetched, streamed). Re-keying would turn every push into an HTTP call.

**Rule 5 — remaining pollers are polite.** Any staff-screen refetch interval
wraps its cadence in the shared polite helper: paused while the tab is hidden,
slowed after idle minutes, refetched once on focus. The helper must survive
partial `document`/`window` stubs in test harnesses.

**Test traps:** stub the `/stream` URL before any `/conversations` catch-all
or the client loops on reconnect; the fake PostgREST router returns the
first-registered handler, so vary a reply with a toggled variable rather than
re-registering; HQ drill-in suites require `office=` on the stream URL too.

**Rule 6 — name the foreign key in every `patients` embed from
`patient_chat_conversations`.** The read-marker junction table gives PostgREST
a second path to `patients`, so a bare `patients(...)` answers HTTP 300
(PGRST201). The feed's poller failed on every tick for its whole life and no
route test noticed, because route tests run against a fake PostgREST that
accepts any select. Use `patients!patient_chat_conversations_patient_id_fkey(...)`
and, for any new PostgREST embed, run the exact select once against the live
project before trusting green tests.

**Live proof recipe (works):** care-team smoke harness `prepare` + `helper` +
`thread`, tester lands via the office helper then does a FULL load of
`/conversations?conversation=<id>` (switching threads legitimately reopens the
stream); `post "<text>"` sends as the fixture patient. Expected idle burst
within ~2 s: ready catch-up (summary/events) + read-marker echo (list+summary),
then silence. A patient message = 1 list hint (list+summary GET) + events on
the stream, 0 events GETs; measured ~1.3 s send→DOM. Hidden tab: emulate with
`Object.defineProperty(document,'visibilityState',…)` + `visibilitychange`;
park at +30 s, show → one new stream (`after=<n>`) + one catch-up. Start DOM
and response watchers BEFORE the show call — a late poll once reported 14.8 s
for what was a 1.3 s render.
