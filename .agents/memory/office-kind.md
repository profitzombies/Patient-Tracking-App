---
name: Office kind (reseller vs software-only)
description: Durable rules for the office kind — how unknown reads, where the kind travels, what each kind is denied, and how the accepted agreement follows the kind.
---

**Unknown kind reads as reseller at every seam; clients never hide on null.**
Every layer funnels through one `officeKindOf()`; a kind still loading (or whose read
failed) is `null` on the clients and hides nothing.
**Why:** existing offices predate the column, and a loading flicker that hid Training
for a reseller would look like a regression.
**How to apply:** new kind-aware surfaces branch on `=== 'software'`, never on
`!== 'reseller'`.

**The kind rides reads the clients already make** (sign-in identity, the office access
read the mobile restriction context polls, the HQ account row for a drill-in). Do not add
a kind poll; add the field to the payload the surface already has.

**HQ keeps reading a software office's Marketing Assets.** The drive is HQ's own; only
non-HQ callers are refused. Training is gated in the database (helpers + policies), so
learner media routes stay open and the anon catalog policy stays world-readable for the
public preview. Any SECURITY DEFINER training RPC that checks the caller's office by
reading profiles directly (not via the helpers) must carry its own kind refusal.

**The accepted agreement follows the CURRENT kind.** An acknowledgment recorded under the
other agreement does not satisfy the setup gate; legacy rows with no recorded agreement
kind are reseller acceptances. Flipping the kind back re-honours the earlier acceptance.
**Why:** the two kinds sign different contracts; HQ changing the kind must not let an
office through on the wrong one.

**wouter Switch gating:** `Switch` flattens fragments and skips `false`, but NOT a custom
wrapper component — gate route groups as `{cond && <>…</>}`.
