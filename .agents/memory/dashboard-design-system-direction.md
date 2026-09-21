---
name: THINNR visual direction
description: The approved visual and information-hierarchy direction for THINNR (web operations + mobile).
---

Use the Heritage evolution of Cobalt Ledger as the visual foundation across THINNR (operations dashboard AND mobile app): cobalt + cream-paper card surfaces, soft geometry (radius 9 cards / 7 controls, small badges ~5), Playfair Display serif for display titles and option/row titles, Inter for labels/body, uppercase micro-labels retained, accent-tinted icon tiles with cobalt glyphs (brand "TH" marks stay navy), sentence-case CTAs, soft box-shadow strings on cards. Retain the guided-operations hierarchy within that language.

**Why:** The user approved the Heritage Hero mockup as the app-wide look (Aug 2026); a coordinated task wave restyled every screen to it. The earlier pure-square Cobalt Ledger geometry is superseded — do not reintroduce square corners or navy icon tiles.

**How to apply:** Consume shared theme tokens (radius/radiusSm, palette, fonts map) instead of literals; never pair fontWeight with weighted font-family names (Android faux-bold); use boxShadow strings, not shadow* props, on Expo web. Avoid generic EHR styling, organic wellness palettes, and alarm-heavy command-center treatment.

Patient gamification concepts must retain this same mobile brand, including full-screen celebrations. Playfulness belongs in collectible artwork and interaction, not a replacement cartoon design system. Use the full “Thinnr” name on these concepts rather than the TH monogram.

**Why:** The user explicitly rejected off-brand milestone explorations with bubble fonts and bright cartoon palettes even while requesting Duolingo-like reward mechanics.

**How to apply:** Ground future reward concepts in the current mobile tokens and screen conventions; interpret Duolingo references as interaction inspiration, not permission to replace the app’s visual identity.

The Heritage “Framed Plate” was the original authentication direction, not an enduring requirement for every entry screen. Later user requests deliberately differentiated the image-led mobile welcome from quieter patient authentication forms; see [Auth entry screen layout](auth-hero-crop.md).

**Why:** The user initially approved the framed-food pairing, but subsequently rejected the photo/badge/greeting on patient forms while explicitly wanting a larger welcome image. Applying the older direction globally would undo those choices.

**How to apply:** Keep screen-specific design intent while preserving auth state, handlers, routes, accessibility labels, and test hooks. Do not restyle provider or operations sign-in as a side effect of mobile patient-entry work.

Status-chip tones (keep consistent across operations screens until they are centralized): healthy/active = accent chip with cobalt text; warm attention (paused-like) = the approved mockup's amber chip (bg #fff4e6, border #e8b47c, text #b65c22 — no warm theme token exists, accent-warm alone fails small-text contrast); risk/overdue = destructive-tinted chip (bg-destructive/10). Chips stay rounded-sm, tiny bold uppercase.

**Hand-rolled SVG charts (operations):** theme them via `className` (`fill-primary`, `stroke-border`, `fill-[hsl(var(--chart-N))]`) — CSS variables do NOT resolve inside SVG presentation attributes (`fill="hsl(var(--x))"` silently fails), and Tailwind cannot see runtime-composed class names (`text-[${VAR}]` emits no CSS; write the literal). Warm/risk states on charts and chips reuse the mobile palette hexes (#b65c22/#fff4e6/#e8b47c warn, #a04646/#fff0f0/#d5a7a7 risk); patient-record chip/card/input recipes live in the operations `components/patient/heritage.tsx` module.
