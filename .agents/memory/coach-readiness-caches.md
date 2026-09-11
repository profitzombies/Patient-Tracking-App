---
name: Coach readiness caches
description: Why fast Coach navigation needs separate readiness, delivery, and access-revocation boundaries.
---

Treat a paintable cached transcript, a server-confirmed saved message, and current account access as separate facts.

**Why:** Making cached conversations usable during background refresh allows a new send to begin after the read started. Replacing the transcript at completion loses that turn; marking every merged row as persisted can silently prevent saving it. A read must merge without claiming ownership of an active reply or certifying an unsaved row.

**How to apply:** When changing Coach hydration or cache behavior, hold a refresh, start a send, then release the old snapshot. Prove both transcript continuity and actual persistence, not just rendered text.

Reject invalidated read results at the promise boundary, not just at the cache-write boundary.

**Why:** A still-mounted history screen can consume a resolved stale page even when the context correctly refuses to cache it. Keep a shared denied state that hides local screen copies immediately, and generation-check failure/requeue paths as well as successful responses.

**How to apply:** Cover a held history success and an append rejection completing after revocation. Public history identity should not change repeatedly on denial, or mount-triggered loads can form a retry loop.

An account boundary invalidates pending uploads; merely selecting another thread does not.

**Why:** Dropping the uploaded path on same-account navigation can save the original message without its photo. Keep the captured write target valid while limiting visible updates to the currently selected thread.

**How to apply:** Pair every held-upload-after-clear test with a held-upload-across-thread-selection test. Return through the warm cache, wait for persistence, then cold-hydrate to verify the photo was not subsequently overwritten.

Refresh freshness only from an authoritative newest-page read.

**Why:** Navigation, older-page loading, and local message changes do not prove the latest remote transcript is current. Refreshing timestamps on those actions can keep stale content “fresh” indefinitely.

**How to apply:** Compare warm request counts within the measured TTL; screenshot-taking and browser-tool overhead can exceed that window and create false cache failures.