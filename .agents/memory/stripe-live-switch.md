---
name: Stripe Live switch
description: Durable lessons from preparing production payments for Stripe Live — what the mode selector does and does not change, webhook API versions, delivery proof, release sequencing, warehouse logins.
---

- The billing repair job walks BOTH billing scopes (Test and Live) whatever mode HQ has selected.
  A broken Test row keeps the job red after the switch; only classifying or resolving that row
  fixes it, never "just go Live".
  **Why:** one quarantined (mode-less) Connect row sent Test subscription lookups to the office's
  newer, unfinished sandbox account, and the job failed on every run until the row was classified.
- Classifying a mode-less Connect row is a replace, never an UPDATE (identity columns are
  trigger-guarded), and it needs the user's explicit decision. Before it, check what was synced onto
  the office's newer account: prices saved after a setup restart live there and are stranded by the
  swap, so the owner must re-save them.
- Live webhook destinations must be created on the server SDK's API family. The live account's
  default was an older family than the sandbox default, so "default" silently picks the wrong one;
  a destination's version can never be changed — recreate, save the new secret, delete the old.
  Each new destination has its own signing secret; users assume the saved ones carry over, so list
  the destinations (versions, events) before opening a secrets form.
- Stripe sends no test deliveries to live destinations. Delivery proof is the first real live event
  (an owner connecting, an owner saving a card) landing processed in the webhook ledger.
- Task changes reach production only after completion → Apply changes → Republish, and secrets also
  need a republish. Anything that must run on the new code in production (mode switch, real-money
  pilot) belongs in a follow-up, not the task that ships the code.
- Warehouse tenants never share or mix logins: live needs the tenant flag AND the complete live
  login, otherwise real orders stay held; the test tenant only ever uses its own login.
  **Why:** a field-by-field fallback would send real orders with the test login.
- The warehouse vendor can flip an existing login from its test environment to production on
  request. Development shares that login, so always ask for a separate production login instead.
