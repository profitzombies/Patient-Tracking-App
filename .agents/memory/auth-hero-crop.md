---
name: Auth entry screen layout
description: Screen-specific intent for welcome versus authentication forms, and the food-image crop lesson.
---

## Welcome is image-led; forms are quieter

Keep the welcome screen visually distinct from login and account creation. The user wants a prominent, edge-to-edge food image and larger wordmark on welcome, but rejected the photo, approved-list badge, and greeting on the patient login and Create Account forms. Do not interpret hero-less forms as a request to strip imagery from every entry screen.

**Why:** The welcome is the brand introduction; the forms are focused tasks. On 2026-09-08 the user specifically asked to enlarge the welcome artwork after rejecting blanket removal from the remaining entry screens. On login, nested cream cards added inset without meaningful contrast, and under-field links made two fields feel like four rows.

**How to apply:** Preserve welcome's image-led composition when restyling forms, and keep form changes scoped. Group related copy/actions instead of distributing empty space between every block. Provider login is not automatically included in patient-entry redesigns.

## Segmented choices on Expo web

Use toggle buttons for channel choices unless implementing a complete tab interaction.

**Why:** RN-web's press responder gives Space activation to button roles, not arbitrary tab roles. A visually correct tablist can therefore break keyboard selection.

**How to apply:** Expose pressed/selected state appropriate to each platform; use tabs only with their keyboard navigation and focus behavior.

## Focus-point crop (where the hero remains)

Food artwork needs a crop chosen around the subject, not a default center crop of whichever container happens to hold it.

**Why:** The seeded home-hero illustration is square with the plate low-right; `resizeMode="cover"` centre-crops a short band into pale tablecloth, and the tester reported the hero as "washed out". An overlay caption + bottom scrim made it worse. Percentage `top` in RN is relative to the parent's height, so the offset has to be computed from the measured width (onLayout), not expressed as a percentage.

**How to apply:** Inspect the source before changing its proportions. A short banner needs a subject-aware crop; a tall welcome image can use the pale upper area for the wordmark. Keep other copy off the food and avoid heavy scrims that wash it out.
