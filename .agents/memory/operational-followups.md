---
name: Operational follow-up semantics
description: Rules for keeping staff review workflow separate from live patient risk.
---

Reviewing an operational follow-up records staff workflow state only. It must never remove, suppress, or reclassify the underlying risk while the live condition still exists. Follow-up rows contain structured reason, status, timestamps, and actor identifiers only; they do not contain free-text notes or clinical payloads.

**Why:** A resolved workflow item means someone reviewed the risk, not that the patient's source condition is gone. Conflating the two would hide active issues and invite sensitive data into a non-clinical operations ledger.

**How to apply:** Derive risk from current patient activity each time. Join the latest follow-up metadata alongside that risk, and offer review/reopen actions without filtering resolved risks out of watchlists.