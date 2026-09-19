---
name: Retention compliance floors
description: How HQ retention floors (audit 6y, clinical record 5-10y) are enforced end to end and why the clinical record window is a separate key from the chat timer.
---
Compliance floors on HQ retention settings are enforced in four places that must move together: shared server bounds (also the OpenAPI minimum, so the zod request schema rejects first with the generic message), the DB CHECK (a migration raises stored rows below the new floor before tightening the constraint), the web field bounds, and a clamp-on-read in the row→policy mapper so a stale lower value reads as the floor and the next unrelated save persists the floor without auditing it as a change.

**Why:** HIPAA requires 6 years of compliance documentation (audit trail); state medical-record windows run 5–10 years. The clinical record window governs closed accounts and offboarded offices only; it is a separate key from the AI chat transcript timer, and care-team (staff–patient) messages are part of the clinical record, never the chat timer — a real-Postgres test pins the trim RPC's thread allow-list and fails if it is widened.

**How to apply:** when adding or raising a floor, add the migration to the coach-migrations apply script with postconditions and apply it live before the API's settings select can include the new column. New hq_organization_settings columns need the route fixture, the retention job fixture, and the operations org-policies script fixture updated in the same change.

Gotcha: the operations org-policies RTR script leaves a live-stream handle open after the conversations page; it needs an explicit process.exit(0) after the success line or the validation command never returns.
