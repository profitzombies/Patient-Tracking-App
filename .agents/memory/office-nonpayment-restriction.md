---
name: Office restricted for nonpayment
description: How the narrowed (unpaid) office state is derived, enforced, and how the elevated revenue share rides charges — separate from lock and offboarding.
---

A restricted office is **narrowed**, not locked: it keeps its own billing/pay screens, patient
subscription management, Stripe payout/connect and patient data export, and loses everything else.
It sits alongside the account lock and offboarding, which still end access entirely.

**Rule: the state is derived, never stored as a flag.** Read it from the access subscription's dates
at request time.
**Why:** payment must restore full access on the very next request with no HQ action; a cached
column drifts and needs someone to clear it.
**How to apply:** lock/offboarded checks run first and keep their own reasons; the restriction gate
runs after them at the shared office scope resolver. A failed or unknown read means *unrestricted* —
narrowing an office that has paid is far worse than briefly missing one that has not, and the charge
path applies the share independently.

**Rule: the allowed surface is one path-keyed policy, applied once at the scope resolver.**
**Why:** per-route decisions drift, and the client copy (web nav + mobile route guard) must be able
to mirror exactly what the server enforces.
**How to apply:** session/account plumbing (sign-in, security, claim) stays open, the way the launch
gate leaves it open. A caller that does not name its request is answered as allowed — the route it
reaches still enforces its own rule.

**Rule: any staff member can pay.**
**Why:** an office whose owner is unavailable must still be able to clear the balance.
**How to apply:** the access/pay routes resolve office scope directly instead of the owners-and-
admins-only billing scope.

**Rule: the share percentage is per-order data, not a constant.**
**Why:** a later restriction (or recovery) must never be read back onto a charge already processed.
**How to apply:** snapshot the applied percent on the order next to the share amount; renewals
re-derive the share from the original order's snapshotted floors at the *current* percent, never from
today's catalog floors. Break-even minimums, catalog floors and practice-launch pricing stay at the
normal share.

**Rule: patients are told nothing about the office's billing.**
**Why:** the patient is mid-program and the dispute is not theirs.
**How to apply:** care-team chat becomes read-only with a neutral "call the office" notice carrying
the phone number; AI coaching is untouched; no banner, badge or error hints at nonpayment.
