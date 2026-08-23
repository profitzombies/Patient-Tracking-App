---
name: Range pickers must restart on the next click
description: react-day-picker (and similar) range mode stretches an existing complete range instead of starting a new one; override onSelect.
---

**Rule:** When a calendar range picker opens pre-filled with a complete range, the first day-click must start a *fresh* selection (`{ from: clickedDay, to: undefined }`). Do not rely on react-day-picker's default `mode="range"` reducer — it moves the nearest edge of the existing range, so "click start, click end" silently produces a stretched copy of the old range.

**Why:** The operations header range control shipped with the default behavior and e2e testing caught it immediately: with Jul 24 – Aug 22 pre-selected, clicking Aug 3 then Aug 10 yielded "Jul 24 – Aug 10" instead of "Aug 3 – Aug 10". Users (and testers) universally expect two clicks to define a new range.

**How to apply:** In any range-mode `onSelect(next, clickedDay)`, check the previous draft: if it already has both `from` and `to`, return `{ from: clickedDay, to: undefined }`; otherwise accept `next`. Keep edits in a local draft committed only by an explicit Apply so Cancel/Escape stay non-destructive.
