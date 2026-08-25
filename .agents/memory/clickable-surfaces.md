---
name: Clickable cards and rows — native anchors only
description: Completion review rejects focusable-div/tr click targets; the approved patterns and the a11y harness that enforces them.
---

**Rule:** a whole-card or whole-row click target must be built on a NATIVE anchor, never a focusable container (`tabIndex={0}` + aria-label + key handlers on a div/tr). Two approved shapes:

1. **Stretched-link card** — container `relative` + title `<Link className="after:absolute after:inset-0 focus-visible:outline-none">`; focus affordance on the container via `has-[a:focus-visible]:…`; any decorative "Open →" affordance becomes an `aria-hidden` span (a second anchor = duplicate tab stop). Costs text selection inside the card — acceptable for cards.
2. **Row with one announced link** — the `<tr>` keeps a pointer-only `onClick` (guards: defaultPrevented/modifier keys/`closest('a, button…')`/text selection) as a bigger hit area, but the REAL control is a visible trailing icon `<Link aria-label="Open <name>'s …">` in normal tab order; no tabIndex/role/aria-label on the tr (invalid table semantics).

**Why:** code review rejected the older Patients-page convention (focusable div/tr + anchors demoted with `tabIndex={-1}`): screen readers are never told the focusable element is an activatable link. Don't copy that convention forward; migrating Patients is open work.

**How to apply:** any new clickable card/row in the operations app should follow the office Training page, and extend its a11y suite (react-test-renderer under tsx with context-module stubs — `tsconfig.a11y.json` pattern) to assert: one in-tab-order anchor per target with href + accessible name, containers semantically inert. Quirk: tsx compiles script JSX with the classic transform — scripts need `import * as React from 'react'`.
