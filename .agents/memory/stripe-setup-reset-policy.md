---
name: Stripe setup reset policy
description: Distinguishes requiring setup confirmation again from replacing an unfinished Stripe connection.
---

Requiring setup again must preserve the current Stripe connection and financial history. Self-service restart is only for an unfinished connection with no financial dependencies; financially used accounts require HQ investigation, never an unchecked force replacement.

**Why:** The user explicitly chose provider self-service for unfinished setup and HQ handling for accounts with payment history. Payments and subscriptions remain attached to their original Stripe account, so treating reset as deletion/replacement risks orphaning them.

HQ may deliberately waive one office's setup gate (demonstration and support accounts can never finish a real Stripe connection). The waiver is HQ-only, changes nothing the office already confirmed, and the setup screen keeps reporting what is still missing. Requiring setup again must clear the waiver in the same statement that clears the completions, or HQ shuts the gate while the office and its staff still walk through it. HQ inspecting an office is never held at that office's setup screen — the server states that (it is the caller's kind, not "can this caller edit", which is also false for office team members).

**How to apply:** Keep gate reset separate from connection restart. Treat submitted verification as potentially becoming ready remotely; ambiguous mutation outcomes need reconciliation rather than automatic retries that could create another account. Do not restore the optional product tour.