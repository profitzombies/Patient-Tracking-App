---
name: Tailwind v4 color-token mapping
description: Custom CSS color vars in the operations app are not utility classes until mapped in @theme inline; unmapped classes silently no-op.
---

In the operations web app (Tailwind v4), defining a color var in :root/.dark (e.g. --chart-1, --warn) does NOT create utility classes. The var must also be mapped inside the @theme inline block as --color-<name> (e.g. --color-chart-1: hsl(var(--chart-1))) before classes like bg-chart-1 or text-warn exist.

**Why:** Unmapped classes fail silently — no build error, no console warning; the element just renders with no fill. The gap stayed hidden for the chart-1..5 vars because recharts consumed them as raw hsl(var(--chart-N)) strings; the first raw-markup div chart using bg-chart-* rendered invisible bars.

**How to apply:** When introducing any semantic color token, add both the :root/.dark definitions AND the @theme inline --color-* mapping, then visually confirm a filled element. If a color class mysteriously does nothing, check the mapping first. Chart 1-5 and the warn trio (warn/warn-bg/warn-border) are mapped now; new tokens need the same treatment.
