---
name: Approved-foods entry points
description: Navigation contract that every "Approved list" shortcut in the mobile app uses to open the Approved Foods screen
---

All "Approved list" entry points in the mobile app (home-hero chip, restaurant-guide footer card) navigate through the single shared constant in the mobile app's `constants/links.ts` (`APPROVED_FOODS_HREF`), which targets the dedicated Approved Foods screen — the same destination the Library tab's own "Approved Foods" button pushes.

**Why:** The shortcuts and the food library were originally built on parallel branches that could not see each other's code; routing every entry point through one constant let them integrate at merge time with a one-line retarget. Hand-written route pushes in multiple files drift apart during merges.

**How to apply:** When adding another approved-foods shortcut, import `APPROVED_FOODS_HREF` instead of hand-writing the route. If the Approved Foods destination changes, retarget the constant — not the individual callsites.
