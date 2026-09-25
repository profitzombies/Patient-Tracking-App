---
name: First-provider Stripe connect path
description: Why a brand-new office's setup screen must offer account creation/OAuth before Stripe's embed, how its refreshes are keyed, and how to live-prove the webhook path.
---

**A new office has no connected account, and Stripe's embedded onboarding cannot load without one** (account-session answers 409). Any surface that can be the owner's first stop (the practice setup gate, not just Get paid) must offer the two starts — OAuth and "Start setup" (create) — while the connect state is `not_started`, and only render the embed after.
**Why:** the gate holds new owners on the setup screen; the embed there was a dead end and the OAuth return path (`/payments/get-paid?connected=1|error=`) is also covered by that screen, so the result notice has to be read there too.
**How to apply:** reuse the shared connect-start cards; after any connect action invalidate by predicate (`office…` and `billing/office…` keys) because the office-access setup snapshot key is not under the office billing base key.

**Live proof of the webhook path:** create a throwaway office, "Start setup" in Test mode, then change the test account directly in Stripe (metadata) and require a processed `connect` `account.updated` row in the webhook events table for that account — the stored-row timestamp alone could be moved by other code. Delete the Stripe test account and the webhook-event rows in cleanup. The OAuth callback and webhooks resolve to the published site, which shares the database.

**Test-office gate without a charge:** HQ setup override opens server gating too (the gate helper checks the override first) while the launch snapshot keeps reporting what is really missing.

**Stripe webhook endpoints do not report `connect`** (it is create-only); a Connect endpoint is recognisable by a non-null `application` (the Connect app id), a platform endpoint has none. Readiness checks use that to catch endpoints registered for the wrong event source.

**Live harnesses that create privileged users** must refuse on the stored payment mode *before* creating fixtures, and every cleanup failure must fail the run with a verified-absent read-back (replica-role deletes skip FK cascades).
