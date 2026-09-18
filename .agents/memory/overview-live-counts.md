---
name: Office Overview live numbers
description: Why the signed-in Overview counts roster rows (not the rollup RPC) and how live finance rides one billing dashboard request.
---
Rule: on the signed-in office Overview, every patient count that links somewhere (Active Patients, Check-ins Overdue, reason cards, attention banner) is computed from the already-fetched roster rows with the SAME shared predicates the Patients page filters use. The `/office/overview` rollup RPC feeds only tiles with no roster twin (inbox, avg pounds lost, pulse date). Finance tiles (MRR, Revenue Trend, failed-payments card) come from ONE billing dashboard request whose `from` covers the prior equal-length window, so total/delta/chart share a response.

**Why:** the rollup's evaluator and the roster's could differ by a patient, so a tile said "3" and its link opened a list of 2. MRR normalization is 52/12 weeks per month summed as yearly cents and rounded once (per-row rounding drifted a cent). A 403 on billing means a staff role without payments rights — render an owners-only notice, not "Error". Prior window collected 0 → delta null ("No prior period"), never an invented %.

**How to apply:** new Overview tiles that link to a roster filter must use `rosterHasReason`/`isActivatedRosterPatient` + `rosterReasonHref`; extend the verify-overview-live suite, which renders both pages on one roster fixture whose `summary` figures are deliberately wrong to catch a regression to the aggregate.
