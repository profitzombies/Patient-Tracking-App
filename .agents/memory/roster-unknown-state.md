---
name: Live roster unknown vs zero
description: Contract for missing activity signals on the signed-in Patients roster — explicit unknown, never zero-filled.
---
Rule: live roster/detail activity signals are nullable per FAMILY (diary family, check-in family, each average), plus a whole-row `status: "unknown"` when the office aggregate has no row for the patient. The UI maps this to a three-way model (value incl. real zero / "no data yet" / dashed "Not available") and filters/sorts treat both null flavours as NOT lapsed and sort them last in either direction. Outreach flags come only from the server's `reasons`.

**Why:** the roster used to zero-fill everything the API didn't send, so "did nothing" and "didn't load" were indistinguishable and outreach filters acted on fakes. The guided demo keeps its seeded LoggingStats untouched (parity suite).

**How to apply:** new roster columns must ride the aggregate RPC (`provider_patient_activity_summary`, one call per office) and `PatientActivitySignals`; the detail page computes the same DTO in TS from raw rows and a SQL↔TS parity test guards the seam — extend both when adding a signal. Streak semantics include today's grace (a streak ending yesterday still counts while today is unlogged).
