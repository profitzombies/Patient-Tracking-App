---
name: Generated recipe image style
description: How coach recipe image generation stays visually consistent with the seeded Library illustration set
---
- All THINNR food imagery is one illustrated family (reference: the mobile app's seeded assets/images/recipes/): square top-down flat illustration, single centered white plate/bowl with cobalt-blue rim, silver utensil beside it, pale cool blue-gray backdrop with cobalt accent circles and dotted-grid patterns, clean saturated food colors, no people/hands/text/logos. The coach image endpoint's prompt encodes this; new generated imagery should reuse that framing.
- **Why:** photorealistic output clashed with the seeded set in the Library grid; prompt wording is the only control surface for style matching.
- **How to apply:** iterate by generating samples for several dish types and comparing side-by-side against seeded assets. Gotchas learned: "crisp outlines" pushes gpt-image-1 into comic-style dark ink lines the seeded set lacks — ask for "soft shapes without dark ink outlines"; bare "flat vector" reads too chunky/toy-like — ask for "finely detailed … delicate highlights". Keep low quality / JPEG / 1024 square: the data URI must stay ~100–150 KB to persist in AsyncStorage/localStorage.
- The AI-recipe preview screen intentionally shows ZERO generation state (no loading/failed/ready UI): generation starts silently on open, the image surfaces only on saved Library entries via the photo-backfill tracker, and a save after a failed attempt quietly retries once. Don't "fix" the missing hero back in.
