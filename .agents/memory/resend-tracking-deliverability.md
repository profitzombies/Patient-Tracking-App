---
name: Resend open/click tracking vs spam
description: Why open and click tracking on the Resend sending domain are off, and what turning them back on costs.
---

**Rule:** keep Resend open and click tracking OFF for the `appnotifications` sending domain. These are domain settings in the Resend account, not code settings.
**Why:** on 2026-09-29 the user reported that only Resend mail (verification codes, alerts) was landing in spam. The authentication records (DKIM/SPF) all passed. The cause was the tracking pixel plus link rewriting through the tracking subdomain, which is a common spam trigger for security mail. The user runs Google Workspace mail on the root domain, where support@ is live, and chose to keep app mail on the subdomain rather than send from the root.
**How to apply:** the HQ email outbox will no longer receive opened/clicked events. Delivered, bounced, and complained events still arrive. Replies to app mail go through the EMAIL_REPLY_TO env var to support@. Do not add the root domain to Resend without asking the user.
