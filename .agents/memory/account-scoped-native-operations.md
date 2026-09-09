---
name: Account-scoped native operations
description: Account-switch safety for long-running device prompts, health reads, secure local preferences, and reminder reconciliation.
---

**Rule:** Any native permission prompt or device read that can outlive the current patient selection must capture an account epoch before it starts, re-check that epoch after every await, and use a bearer captured for that same account when sending patient-owned data. Reminder reconciliation must also version the user's desired settings so stale AppState or hydration work cannot recreate schedules after a newer edit or disable.

**Why:** Native sheets and health reads can remain open while the user signs out or switches accounts. Reading the current session only when the request is finally sent can attach the first account's device data to the second account. Serialization alone does not prevent stale lifecycle work from running after newer user intent.

**How to apply:** Use this pattern for future device integrations, secure local enrollment, background/foreground reconciliation, and any account-owned upload initiated before a native await. Stale work should be discarded without mutating shared UI state.

**Unsupported-platform rule:** an unsupported capability must explicitly settle its per-account loading gate, not merely return from the loading effect. **Why:** the native biometric gate treated an unset account-loaded marker as locked; skipping the web effect left real web patients permanently locked even though web cannot enroll biometrics. **How to apply:** test a real-account initial load and account switch on both supported and unsupported platforms; keep native fail-closed behavior while settling web as unavailable/unlocked.