---
name: Patient local day
description: How "today" is computed for real patient accounts vs the demo persona, on device and server
---

# Patient local day

**Rule:** Real accounts ride the device-local calendar day everywhere (`patient.todayKey` → `localTodayKey()`); the demo persona keeps the fixed seeded anchor so demo suites stay byte-identical. The server NEVER derives a day from its own UTC clock: when a request omits the app's local day it uses the patient's stored profile `timezone` (`dayKeyInTimeZone`), with UTC only as a last resort for a null/invalid tz.

**Why:** Server-invented UTC "today" flips to tomorrow at 8 PM New York; evening users saw the wrong date and their saves stranded on the wrong day. The demo anchor date must survive untouched for seeded parity.

**How to apply:**
- New screens/flows read the day from `patient.todayKey` (or `localTodayKey()` for real-only paths) — never `TODAY_KEY` directly, never `new Date().toISOString()`.
- Server routes that need "today": profile fetch first, then `dayKeyInTimeZone(profile.timezone)`. Incoming date keys are validated with an UPPER bound only (`maxPlausibleDayKey` = UTC+14 day + 1 skew day); past days stay legal because diary browsing and backfill write past days by design. Writes 400 on violation; reads fall back silently.
- Local-midnight rollover: the day recomputes on AppState foreground + screen refocus; deliberate date browsing is preserved.
- Suite expectations must split by persona: demo sections assert the anchor, real-account sections assert `localTodayKey()`. An evening-in-NY case (TZ=America/New_York + frozen Date at ~01:30Z) proves the boundary.
