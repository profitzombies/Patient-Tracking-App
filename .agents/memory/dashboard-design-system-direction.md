---
name: THINNR visual direction
description: The approved visual and information-hierarchy direction for THINNR (web operations + mobile).
---

Use the Heritage evolution of Cobalt Ledger as the visual foundation across THINNR (operations dashboard AND mobile app): cobalt + cream-paper card surfaces, soft geometry (radius 9 cards / 7 controls, small badges ~5), Playfair Display serif for display titles and option/row titles, Inter for labels/body, uppercase micro-labels retained, accent-tinted icon tiles with cobalt glyphs (brand "TH" marks stay navy), sentence-case CTAs, soft box-shadow strings on cards. Retain the guided-operations hierarchy within that language.

**Why:** The user approved the Heritage Hero mockup as the app-wide look (Aug 2026); a coordinated task wave restyled every screen to it. The earlier pure-square Cobalt Ledger geometry is superseded — do not reintroduce square corners or navy icon tiles.

**How to apply:** Consume shared theme tokens (radius/radiusSm, palette, fonts map) instead of literals; never pair fontWeight with weighted font-family names (Android faux-bold); use boxShadow strings, not shadow* props, on Expo web. Avoid generic EHR styling, organic wellness palettes, and alarm-heavy command-center treatment.

Status-chip tones (keep consistent across operations screens until they are centralized): healthy/active = accent chip with cobalt text; warm attention (paused-like) = the approved mockup's amber chip (bg #fff4e6, border #e8b47c, text #b65c22 — no warm theme token exists, accent-warm alone fails small-text contrast); risk/overdue = destructive-tinted chip (bg-destructive/10). Chips stay rounded-sm, tiny bold uppercase.
