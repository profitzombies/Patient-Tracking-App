---
name: Onboarding route admission
description: Why real-patient route guards must wait for confirmed onboarding persistence.
---

For real patient accounts, route admission must use the last server-confirmed onboarding-completion state. Final onboarding should persist successfully before changing mode or navigating to a protected patient destination.

**Why:** An optimistic completion flag briefly unlocks protected routes even when the write fails, then reverses after reload. Navigating before persistence also races the route guard and can bounce a finishing patient back to the welcome screen.

**How to apply:** Keep intermediate onboarding answer saves non-blocking if desired, but make the final completion action await its write. On failure, retain the active run, leave protected routes locked, and expose retry without navigating.

**Legacy completion rule:** A server-confirmed onboarding completion must not also require a newer profile-completion timestamp. Treat office program pauses and discharges separately from account disablement.

**Why:** Older completed accounts can lack the newer timestamp; duplicating that prerequisite made the app admit patients to bloodwork and then reject their saves as missing patients. Program status was also incorrectly used as an account-access lock.

**How to apply:** When adding an admission check to a patient-owned feature, trace the existing entry policy and test a completed legacy account through real request handlers. A smoke fixture that manually fills every admission field cannot reveal this mismatch.