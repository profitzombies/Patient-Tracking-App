---
name: Patients menu badge & attention-first flag
description: Decisions behind the office Patients badge (live summary vs seeded demo), the ?attention=first URL flag, phone search, and how to render the office Shell under Node.
---
**Rule:** The Patients badge reads the SAME react-query entry the roster page uses (call the shared live-roster hook; never a second query/interval). Flagged truth is the per-patient evaluator verdict (`attention.flagged`) and `summary.attention`, not the narrower `operational.status === 'needs_attention'` bucket. Demo counts come from the shared demo attention builder (the bell's rule) — expect most seeded patients flagged (30/32), so the demo badge is amber by design.

**Why:** the badge, bell, and Needs-attention page must never disagree; loading/error must show no number (an empty chip beats a false 0).

**How to apply:** attention-first ordering is URL-only (`?attention=first`, cleared by replace-navigation that keeps other params); the phone tab bar deliberately carries no flag (it has no badge). Phone search = one digit normalizer (strip non-digits, drop leading US 1 at 11 digits) matched by substring against both raw and display phone.

**Rendering the office Shell in a Node RTR suite:** stub session/provider-scope/supabase (a11y + invite stubs), the DOM-free popover, and the header DateRangeControl (needs its own provider); polyfill window.history, rAF/cAF, local/sessionStorage, and a minimal `document` (title, querySelector→null). The toast store is observable by mounting a probe component that calls useToast alongside the Shell. Side-menu renders the item list once per breakpoint layout, so assert on `findAll`, not `find`.
