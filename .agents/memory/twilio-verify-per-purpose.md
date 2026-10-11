---
name: Twilio Verify codes are per number, per service
description: Why texted one-time codes for different purposes cannot share one Twilio Verify service, and how the fake in the auth suite models it.
---

# Rule

Twilio Verify issues ONE pending code per phone number per Verify service and re-sends
that same code on a repeat start while it is pending. The ledger's purpose check is
therefore no isolation for texted codes: two purposes on the same service, same number,
same minute hold the same code. Any purpose whose proof is destructive (account
deletion today) rides its own Verify service via its own env var; without that var the
rail fails closed (503 at start, before identity lookup, so it is not an existence
oracle) rather than falling back to the shared service. HQ launch readiness probes each
service separately.

**Why:** a reviewer showed that a sign-in or recovery text requested concurrently would
have confirmed a web delete-account request on the shared service.

**How to apply:**
- New texted-code purposes decide explicitly: share the default service (sign-in-grade
  proofs) or add a service + env key to the purpose→service map in the delivery module.
- Server-generated SMS codes were rejected as the alternative: no Messaging sender is
  configured and Verify custom codes need account enablement.
- The auth suite's Twilio fake keys pending codes by (service SID in path, To) and only
  approves through the same service; simulate concurrency by starting both purposes for
  one number and asserting the crossed code is refused. Legacy tests still use the
  global approved-code knob.
- The second service was created in the owner's Twilio account via the API
  ("Thinnr Account Deletion"); the SID is a shared env var, not a secret.
