---
name: First-time office setup wizard
description: Routing, resume and Stripe rules for the step-by-step new-office wizard vs the legacy practice setup page.
---
Only first-time full setup (fullSetupRequired && required && !completedAt) gets the wizard; legacy/partial/finished offices keep the practice setup page.
**Why:** the user asked that existing offices see no change.
**How to apply:** the guard keeps the wizard mounted after activation (completedAt flips underneath it) until the office leaves "You're all set"; don't re-derive eligibility from completedAt alone or the finish screen vanishes.

- Step "done" state comes only from server data (launch + access snapshot) so resume works across devices; ready security is skipped both forward and back (read-only viewers see every screen).
- Products are never a step: suggested prices are auto-saved server-side (office callers only), never overwriting office-set prices.
- Activation accepts Stripe "pending" like "ready" (shared rule, see practice-launch-stripe-pending.md) — keep the wizard Review gate in lockstep.
- Switching Stripe paths reuses the unfinished-setup restart; a 409 (financial history) locks switching and points to support.
- The first-charge date before activation is an estimate (free period starts at activation) — say "would be … if you activate today".
- The floating Stripe corner icon was taken to be Stripe.js's developer assistant; it is disabled via `developerTools.assistant.enabled:false` (not visually confirmed on a live account).
- Never promise "cancel anytime" — the HQ disclosure text doesn't support it.
- RTR suite: dedicated tsconfig must set jsx react-jsx and list ALL stub paths (child `paths` replace the parent's, they don't merge).
