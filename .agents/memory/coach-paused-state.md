---
name: Coach paused state (mobile)
description: How the mobile coach honors HQ's availability toggle.
---
**Rule:** real accounts probe coach availability when the chat opens and treat a paused 503 on send as a terminal, non-retryable state: withdraw the waiting bubble, lock the composer with the server's wording, and no-op further sends. Demo accounts never probe.

**Why:** "coach paused by your care team" must read as a deliberate decision, not an outage — an error bubble with retry would imply it might come back in a moment.

**How to apply:** other coach entry points (launcher, shortcuts, outreach) should reuse the same probe rather than a second availability source.
