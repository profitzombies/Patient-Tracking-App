---
name: Corner launcher shelf
description: Both personas' corner FAB+menu share one component; patient bottom-corner stacking (tab bar → FAB → snackbar) has a single source of truth.
---

# Corner launcher & patient stacking shelf

Both personas' bottom-right launcher (navy 56px circle + cream popout menu) render through ONE shared config-driven component (`components/ui/FabMenu.tsx`); the per-side files are config wrappers only. A verification suite statically rejects wrappers that grow their own modal/animation/StyleSheet, so menu styling cannot drift between personas.

**Patient bottom-corner stacking** is centralized in `constants/layout.ts`:
- tab bar allowance (web fixed 84px; native insets + 84) → FAB bottom (+14 gap) → snackbar bottom (FAB top + 12).
- The snackbar was deliberately raised ABOVE the launcher (Material snackbar-over-FAB) because its corner UNDO button would otherwise sit exactly under the circle.

**Why:** patients keep a visible tab bar (staff don't), so patient floating UI needs shelf math, and multiple floating elements share the same corner.

**How to apply:** any NEW floating patient-side UI (toasts, pickers, badges near the bottom edge) must join the shelf constants rather than hardcoding bottom offsets — otherwise it lands under the FAB or the snackbar on some platform variant. When adding menu rows, note testIDs are computed (`<prefix>-menu-<key>`), and row "navigate" actions get active-tick + skip-if-already-there semantics while "push" actions always push.
