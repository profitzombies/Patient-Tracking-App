---
name: Pending food amount intent
description: Keep editable quantity previews and every configuration-changing action on the same effective amount.
---

Preserve raw numeric text while typing, but synchronously resolve it before
every unit, preparation, favorite, or final-save action. Invalid text blocks
transitions without being consumed. Favorite presentation and toggle direction
must use the effective configuration, not the previously committed amount.

**Why:** A press can run before TextInput blur commits the amount. A preview-only
fix can show one quantity while converting another, reinterpret pending ounces
as grams, or reverse the favorite action using the old configuration's status.

**How to apply:** Use the resolved draft returned by the amount-validation seam
instead of waiting for a state update. Keep decimal text such as `2.` intact
during editing. Cover action sequences without invoking blur in screen tests;
ordinary blur-then-click tests hide the ordering failure.