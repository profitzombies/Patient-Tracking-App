---
name: Patient floating bottom row & corner launcher
description: Both personas' corner FAB+menu share one component; the patient bottom row (custom pill tab bar + FAB + snackbar) has a single source of truth in constants/layout.ts.
---

# Corner launcher & the patient floating bottom row

Both personas' bottom-right launcher (navy 56px circle + cream popout menu) render through ONE shared config-driven component (`components/ui/FabMenu.tsx`); the per-side files are config wrappers only. A verification suite statically rejects wrappers that grow their own modal/animation/StyleSheet, so menu styling cannot drift between personas. Menu rows are grouped into labelled sections; testIDs are computed (`<prefix>-menu-<key>`, `<prefix>-menu-section-<key>`). Row `navigate` actions get the active tick + skip-if-already-there; `push` actions always push.

**Patients navigate from a floating row, not a system tab bar.** The react-navigation bar is switched off (`tabBar={() => null}` — all five screens stay registered so tab state and deep links survive) and a hand-rolled Heritage pill bar renders beside the launcher in the layout. Destinations that don't fit the pill live at the top of the launcher's menu.

**Why:** a full-width system bar plus a floating circle collided in the same gutter and looked broken; a custom pill also lets one seat push a NON-tab route (the coach chat lives outside the tab group) which a real tab bar cannot do.

**Consequences to respect:**
- A hand-rolled bar owes its own accessibility: `tablist` container + `tab` seats + selected state (set both the RN `accessibilityRole` and the web `role`). As plain buttons it silently loses "tab 2 of 4, selected".
- Screens the bar has no seat for must light NO seat — the menu row carries the marker instead. A bar that lies about location is worse than one with nothing lit.
- The active seat is marked by lighting the WHOLE seat (pale cobalt capsule the size of the seat), never an underline/tick. **Why:** an underline has to be paid for out of the seat's own height, so every icon in the bar shifts upward to reserve space for a marker only one seat ever shows — the user read the whole bar as misaligned. Any future marker must cost zero vertical space.
- Dropping the iOS liquid-glass `NativeTabs` branch is deliberate: a system bar cannot coexist with a custom pill.

**Stacking is centralized in `constants/layout.ts`** — bar bottom → FAB bottom (centered on the bar) → snackbar (bar top + 12) → scroll content padding. The snackbar deliberately rides ABOVE the row because its corner UNDO would otherwise sit under the circle.

**How to apply:** any NEW floating patient-side UI (toasts, pickers, badges near the bottom edge) must join those constants instead of hardcoding bottom offsets, and every patient screen pads its scroll view from the shared content-bottom helper — a leftover literal is exactly how content starts hiding under the row again.

**Verifying it:** the RTR suite renders the real layout, so it proves structure/semantics but NOT rendered scroll padding; confirm true-bottom clearance in a browser by scrolling the inner scaled-canvas container programmatically (`scrollTop = scrollHeight`) — a tester's plain scroll gesture silently no-ops and produces identical "content is hidden" screenshots at the same stuck position.
