---
name: Medication records, reminders, and adherence
description: Durable decisions behind per-patient medication schedules shared across API, mobile, and web, and the device-reminder traps.
---
**One schedule core, copied byte-identical into each package, with a parity test enforcing identity.** Edit the API copy and re-copy; never patch a downstream copy.
**Why:** mobile and web cannot import the API package, yet due/taken/missed math must agree exactly across all three surfaces.

**Device reminders are derived from the medication records, never stored as free-standing alarm times.** Reconciliation is a signature diff of the whole plan (records, times, weekdays, timezone, account). Expo weekdays are 1-based (Sunday = 1) while records are 0-based.

**Reminder coordinator: latest plan wins; only the user's explicit enable/disable is pinned.** Ordinary plan changes (medication edits, day rollover, timezone) must supersede the scheduled plan; the only thing to refuse is an observed server-flag plan whose enabled state contradicts the last local enable/disable (lagging flags). Refusing every changed signature froze reminders after the first enable — code review caught it.

**Notification actions must foreground the app.** There is no background notification-response task, so a `Taken`/`Skip` action registered as background-only is silently dropped whenever the app is suspended or terminated. Foreground the app and let the response bridge (plus the last-response replay on cold start) log the dose. Code review rejects the background-only variant.

**Log the dose for the local day the reminder FIRED, not the tap day.** Expo's response `date` is seconds on iOS and milliseconds on Android; normalize by magnitude.

**Adherence is a separate nullable roster input** (null = no doses have come due, never zero) so existing engagement definitions stay untouched. Dose logs are keyed per occurrence; a correction replaces the row rather than appending.

**Onboarding branch:** GLP-1 asks an injection-day step (gated steps need a blocked hint and a runtime spec in the onboarding-gate suite or its static guard fails); a record stopped today is grouped under STOPPED immediately even though its last doses still fire.
