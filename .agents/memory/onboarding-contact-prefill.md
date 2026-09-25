---
name: Onboarding contact prefill & comparison
description: Why real-account onboarding identity fields must survive the welcome reset and be compared/displayed via E.164 normalization.
---
Rule: on-file contacts are stored E.164 (+1…). Compare typed vs on-file only through the shared normalizer (phones → E.164, emails → trimmed lowercase), and display stored phones by stripping the +1 first — the progressive US mask keeps the FIRST 10 digits, so a raw "+15551234567" shifts the "1" into the area code.

The welcome screen's fresh-start reset runs after the prefill effect has already fired, and the prefill effect is gated on "run not begun", so a reset that returns bare defaults leaves the identity step empty forever. Reset must re-overlay the account profile for real accounts (demo stays bare).

**Why:** patients were stuck on the identity step: prefill wiped, retyped phone never matched, and a blanket "valid email" hint blamed a correct gmail address.

**How to apply:** any new contact field or step that reuses on-file data joins the same overlay helper used by both the prefill effect and reset; Node suites stub the patient store via the aliased PatientContext import (relative imports can't be path-mapped).

## Verified state (Confirm your details page, 2026-09-25)
Rule: a contact counts as verified only when the profile's verified flag is set AND the typed value still matches the on-file value. Matching alone never skips a code. Signup stamps the contact its code proved (invite: compare the invitation identifier to the on-file contact; new signup: always phone). Never overwrite an existing stamp.
**Why:** the page promises "no second code for what you already proved"; values on file from an office invite were never proven by the patient.
**How to apply:** patients created before signup stamping have no flags and will see code actions for both contacts until a backfill runs.
