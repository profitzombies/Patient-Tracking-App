---
name: Custom tab labels drop accessible names
description: React Navigation bottom tabs — a function tabBarLabel loses the accessibility label unless tabBarAccessibilityLabel is set per screen.
---

Rule: whenever a `Tabs.Screen` uses a **function** for `tabBarLabel` (custom label renderer, e.g. a styled label with an active-tab tick), also set `tabBarAccessibilityLabel: '<same label text>'` on that screen.

**Why:** With a string label, React Navigation's BottomTabBar derives the tab button's accessible name (aria-label on web, VoiceOver label on iOS) automatically. With a render function it leaves `accessibilityLabel` undefined, so every tab loses its screen-reader name — an invisible regression that typecheck, unit suites, and visual smoke tests all pass over. Caught only by an architect review + DOM aria-label inspection.

**How to apply:** Any restyle or new tab bar in the mobile app (both patient and staff Classic layouts already do this — copy their pattern). Verify by asking the web tester to read `getByRole('tab')` accessible names, which is cheap and needs no screenshots.
