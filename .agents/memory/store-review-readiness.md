---
name: Store review readiness
description: Rules for the Apple/Google reviewer sign-in path and the App Review office that keep them safe and out of customer metrics.
---
Rule: reviewer identities exist only in a production env var (one patient contact + one staff email, each with a fixed code). The fixed code is honoured only when the identity's account currently sits in the flagged App Review office — bound at issuance AND re-checked at verification (same account class, same record, office still flagged). HQ logins never qualify, and the variable is read per call so removing it also refuses already-issued reviewer rows.

**Why:** store reviewers only have a username/password form; THINNR has no password-only login and staff have SMS MFA. Binding the privilege to the office (not just the identifier string) means a leaked or reused env value cannot unlock a real customer's account, and an identity promoted to HQ or moved to another office cannot carry the MFA skip with it.

**How to apply:** treat the App Review office as "signable but not a customer" — any new customer-facing rollup, email, outreach or SQL insights RPC must exclude it through the shared office-status predicates, never ad hoc. Listing kit, reviewer notes and the device checklist live in `docs/store/`; reviewer-notes navigation paths must match the real app — verify by grep before editing copy.
