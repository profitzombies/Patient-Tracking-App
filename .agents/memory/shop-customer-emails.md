---
name: Branded shop emails & Stripe emails off
description: Why shop emails key their once-only claim on the transition, why cancel paths need an idempotent guard, and why "Stripe emails off" is structural rather than an API setting.
---
**Rule:** a customer email for a money/state transition claims a dedupe row (keyed on *what changed*: id + the changed timestamp/stamp) before composing, inside the function that owns the transition, never in a route or client. Duplicate claim = silence; failed send = recorded on the claim, never thrown.

**Why:** webhooks redeliver, reconcile replays, and staff/patient double-tap; the same server function re-enters. Keying on the changed value (not "now") gives a *moved* shipment a fresh reminder while a replay stays silent. Review rejected a build where one path (cancel-at-period-end) still called the legacy sender directly: every existing sender must be migrated, and end-state actions need an "already there" guard so a repeat neither rewrites Stripe nor claims again.

**Email deep links must resolve to a route the patient app actually has.** Verify the link target against the Expo `app/` tree and make the screen consume the query (focus + pre-selected action) before shipping the template; the studio proof cannot catch a dead link.

**Stripe customer emails:** Stripe exposes no API for its Dashboard email toggles. The guarantee is structural: THINNR-created accounts have no Dashboard (off by construction), OAuth/full-dashboard accounts are `unverified` until HQ attests, the platform never charges directly, and a source-scan test forbids receipt/invoice-email fields. Health surfaces must warn on *unverified* too, not only *on*; otherwise the state HQ must act on is invisible.
