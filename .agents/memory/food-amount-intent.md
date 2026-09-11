---
name: Pending food amount intent
description: Keep editable quantity previews and every configuration-changing action on the same effective amount.
---

Preserve raw numeric text while typing, but synchronously resolve it before
every unit, preparation, favorite, or final-save action. Invalid text blocks
transitions without being consumed. Favorite presentation and toggle direction
must use the effective configuration, not the previously committed amount.

**Why:** A press can run before TextInput blur commits the amount. A preview-only
fix can show one quantity while acting on another, or reverse the favorite
action using the old configuration's status.

**How to apply:** Use the resolved draft returned by the amount-validation seam
instead of waiting for a state update. Keep decimal text such as `2.` intact
during editing. Cover action sequences without invoking blur in screen tests;
ordinary blur-then-click tests hide the ordering failure.

Explicit Food Details unit-picker changes preserve the numeric amount: two cups
becomes two ounces, then two grams. Do not physically convert the amount or reset
it to one. Type/preparation changes retain their separate physical-conversion
policy.

**Why:** The user explicitly chose number-preserving unit changes, including
weight-to-weight choices. Older physical round-trip tests describe a superseded
picker policy, not a requirement to restore.

**How to apply:** Consume the valid pending number, then apply it in the new
documented unit against the immutable source nutrition basis. Preserve source
quantity and recorded gram statements independently of the editable display.