---
name: Auth hero photo crop
description: Why the Framed Plate auth hero positions its square photo by a focus point and keeps copy on a strip beneath it, not over it.
---

The plate hero on the mobile auth screens lays the square photo out at the band's width and slides it by a fixed focus-point ratio so the plate's centre lands mid-band. Badge + greeting sit on a cream strip under the photo.

**Why:** The seeded home-hero illustration is square with the plate low-right; `resizeMode="cover"` centre-crops a short band into pale tablecloth, and the tester reported the hero as "washed out". An overlay caption + bottom scrim made it worse (most of a 144pt band was scrim). Percentage `top` in RN is relative to the parent's height, so the offset has to be computed from the measured width (onLayout), not expressed as a percentage.

**How to apply:** Any short banner reusing a square recipe/plate image needs a focus-point crop, not plain cover. Keep text off the photo; use the strip. Prefer the shared `components/auth/AuthPageFrame` + primitives for new auth-style entry screens so spacing stays on the 8pt scale in `constants/spacing.ts`.
