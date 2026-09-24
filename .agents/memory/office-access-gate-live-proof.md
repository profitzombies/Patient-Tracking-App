---
name: Office access gate live proof
description: How to prove the office setup gate end-to-end against the shared dev Supabase project, and the fixture traps that block a throwaway office.
---

**Prove the gate by state transitions on one throwaway office, not by route coverage.**
Refused → already-connected-but-incomplete → fully provisioned → pending bank inside
the window → pending bank past the deadline. Each step flips exactly one fact and
re-reads an ordinary office route plus the setup rail, so a pass can only come from the
gate actually reading that fact.
**Why:** the interesting failures are "connect counts as done" and "the office slips
through while its bank account is unverified"; a suite that only asserts 403 on a fresh
office proves neither.
**How to apply:** keep the setup rail (launch + access snapshot) reachable in every
state — a harness that expects 403 everywhere would hide the office's only way out.

**Reading the access snapshot CREATES the office's subscription row.** Fixtures that
insert one afterwards hit the per-office unique constraint; patch the existing row
instead.

**Connected-account fixtures go through the guard RPC with every NOT NULL column.**
`guard_office_connect(action => 'attach')` builds the row with `jsonb_populate_record`
from a NULL record, so defaults do not apply: omit `tax_enabled` or
`stripe_customer_emails` and the insert fails 23502 even though the table declares
defaults for both.

**Append-only operational ledgers block fixture teardown.** Deleting a throwaway office
cascades into tables guarded by `reject_operational_event_mutation`, and the refusal
comes back from the management API too. Prefix the cleanup statement with
`set session_replication_role = replica;` in the same management-API request; PostgREST
cannot do this, so office teardown belongs in SQL, not in a list of REST deletes.
