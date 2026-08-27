---
name: Food name casing seams
description: Which inbound food-name sources get Title Case, where the one seam per source lives, and what stays source-verbatim.
---

# Food name casing seams

External food names are normalized to the app's Title Case at exactly ONE
seam per entry point — never per call site, never re-cased downstream:

- Barcode lookups: the mobile client's defensive parse of the lookup
  response (the single funnel every scan result passes through). The scan
  list, added/duplicate notices, stepper voice-over labels, and saves all
  inherit from it.
- Meal-photo reads: server-side payload assembly (where the meal name was
  already title-cased). Chat per-food lines print card names verbatim.

Stays verbatim by decision, do not "fix":
- BRAND lines (SweetTARTS) — exactly as the source spells them.
- Menu photo scans — dish names keep the menu's own wording.
- The shared barcode facts table — server stores source casing; casing is
  presentation-side only.
- Previously saved foods/diary/chat cards — no retroactive re-casing.

**Why:** one seam keeps every surface (list, notices, a11y labels, cards,
breakdown, saves) byte-identical without scattering toTitleCase calls, and
brand/menu wording is treated as ground truth the app must not editorialize.

**How to apply:** when adding a NEW inbound food-name source, title-case at
its single entry seam (client parse or server payload assembly), leave
brands/source stores verbatim, and pin fixtures with brand inner caps
(PB&J, McCann's) plus lowercase connectors in the suite at that seam.
The title-case helpers (mobile lib and server text-style) are behavioral
twins — keep them in lockstep.
