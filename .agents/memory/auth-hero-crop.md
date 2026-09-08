---
name: Auth entry screen layout
description: Why the mobile sign-in/create-account screens run without the plate hero or a form card, and the focus-point crop rule for wherever the hero still appears.
---

## Sign-in and Create Account: no hero, no card (user-directed, Sept 2026)

The user explicitly rejected the plate photo + "APPROVED LIST" badge + time-of-day greeting on Create Account and Login, and called the login form "too far out". Login is the reference: kicker → title → subtitle, then fields directly on the page at the 20pt margin with no card. (Create Account lost the hero but still has its card; welcome and provider login still have both.)

**Why:** The card was cream-on-cream with the same hairline border as the inputs, so it added no contrast, only a second 16pt inset. Under-field links ("Use email instead", "Forgot password?") made two fields read as four rows. Choices above the stack, secondary actions on the label row, footer pinned low, kicker in plain words ("SIGN IN", not "PATIENT ACCESS").

**How to apply:** New or restyled auth entry screens follow the login pattern rather than re-boxing. Segmented choices are toggle *buttons* (aria-pressed), not tabs: RN-web only gives Space activation to button roles, and tabs would owe roving focus nobody implements. Keep existing testIDs when re-chroming.

## Focus-point crop (where the hero remains)

The plate hero lays the square photo out at the band's width and slides it by a fixed focus-point ratio so the plate's centre lands mid-band. Badge + greeting sit on a cream strip under the photo.

**Why:** The seeded home-hero illustration is square with the plate low-right; `resizeMode="cover"` centre-crops a short band into pale tablecloth, and the tester reported the hero as "washed out". An overlay caption + bottom scrim made it worse. Percentage `top` in RN is relative to the parent's height, so the offset has to be computed from the measured width (onLayout), not expressed as a percentage.

**How to apply:** Any short banner reusing a square recipe/plate image needs a focus-point crop, not plain cover. Keep text off the photo. Spacing stays on the 8pt scale in `constants/spacing.ts`.
