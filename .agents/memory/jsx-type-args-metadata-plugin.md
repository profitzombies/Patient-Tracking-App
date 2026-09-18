---
name: JSX explicit type arguments break the dev preview
description: Why `<Comp<'a' | 'b'> …>` typechecks green but crashes the Vite dev server in this workspace, and the pattern to use instead.
---
Rule: never write explicit type arguments on a JSX tag (`<Toggle<'lastHour' | 'lastDay'> …>`) in the web apps. Instantiate the generic once at module level (`const LatencyWindowToggle = Toggle<'lastHour' | 'lastDay'>;`) or let inference do it.

**Why:** the dev-only Replit JSX metadata Babel transform splices `data-replit-metadata="…"` directly after the tag name, producing `<Toggle data-replit-metadata=… <'lastHour' | 'lastDay'>` — a parse error. `tsc` and the production build are green, so the breakage only shows as a Vite error overlay on EVERY route of the artifact (the whole preview goes down, not just that page), and the testing subagent reports it as a blocked run.

**How to apply:** if the preview shows "Unexpected token (L:C)" pointing at a JSX line with `<Name<…>`, that is the cause. Grep `<[A-Z][A-Za-z]*<'` before presenting. Also: the admin shell scrolls an inner `overflow-y-auto` column, not the document — testers measuring document scrollHeight at phone widths will misreport "clipped content"; ask them to scroll the nearest scrollable ancestor.
