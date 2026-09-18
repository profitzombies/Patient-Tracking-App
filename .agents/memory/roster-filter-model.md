---
name: Roster filter model
description: Conventions behind the Patients roster quick sets / stackable filter builder, and the RTR test traps met while proving it.
---

Filters are a pure client-side model over the ≤500-row roster page: conditions AND-stack, live in the URL as repeated `f=field:op:value` + `sort=field.dir`, and legacy arriving keys (`status`, `logging`, `reason`, `subscription`) are parsed then rewritten as conditions on first change.

**Why:** shareable/bookmarkable views were the requirement, and the Overview/alerts links predate the model — dropping legacy keys silently would break those entry points.

**How to apply:**
- Missing facts (no weight, spend unknown, null subscription/lapsed) never match ANY operator, "is not"/"no" included — unknown is not false. A loaded aggregate with no orders is a real $0.
- Sets that carry a sort (Top spenders, Inactive / lapsed) only count as "active" when the sort matches too; "All" resets to the default sort. Header sorting now persists in the URL, so suites asserting `/patients` after a header click must expect `?sort=…`.
- Demo statuses map into the live vocabulary (overdue → needs_attention, graduated → maintenance stage); demo chips print the raw lowercase demo word, so text checks are case-sensitive.
- Radix Select needs a document even while closed: every Node RTR suite that renders Patients must map select/sheet/command/calendar (and popover) to the DOM-free office-admin stubs in its tsconfig.
- RTR `find` returns the OUTERMOST match (deep:false), so a stubbed trigger's composite instance shadows the host button's data-value — test helpers must filter to `typeof node.type === 'string'`.
