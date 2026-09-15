---
name: Fixed-layout table width budget
description: Why the office roster table uses table-fixed and how to size its columns without starving the flexible one
---
Rule: roster-style tables with long unbreakable cell text (emails) must use `table-fixed`; `truncate` alone does nothing in auto layout because the cell's min-content width still includes the whole email, so the table silently overflows its card.

**Why:** the Patient Roster polish went through three capture rounds: auto layout overflowed on emails, then a fixed layout whose reserved widths summed past the ~1100px card at 1440 starved the unsized Check-ins column to ~70px (header text overlapped).

**How to apply:** keep exactly one unsized column (the widest content) and make the reserved widths + paddings sum to well under the card width at the smallest supported desktop viewport; nowrap buttons in an action column must fit that column's reserved width or they add invisible overflow (measure `table.scrollWidth` vs wrapper `clientWidth`).
