---
name: Announced error pattern
description: How inline errors get announced to screen readers in the mobile app, and how blocked CTAs give feedback instead of swallowing taps.
---

# Announced error pattern (THINNR mobile)

**Rule 1:** The onboarding `ErrorBox` widget self-announces: `accessibilityRole="alert"` + `accessibilityLiveRegion="polite"` (covers web via role/aria-live and Android via live region) plus an explicit `AccessibilityInfo.announceForAccessibility` on iOS, where RN has no live-region support. Reuse it (or copy this exact trio) for any message that must reach screen readers; do NOT wrap it in another live region — nesting causes double announcements.

**Rule 2:** A disabled primary CTA that gates progress must not silently swallow taps. `PrimaryButton` supports `onDisabledPress`: the button stays visually dimmed and semantically disabled (`accessibilityState={{ disabled }}` → aria-disabled) but remains pressable so the tap can surface an explanation. `OnboardingFrame` wires this via its `nextBlockedHint` prop: tap-while-blocked shows an ErrorBox above the button, cleared automatically the moment input turns valid.

**Why:** Screen-reader users get zero feedback from a natively-disabled Pressable (not focusable, no announcement), and sighted users stall with no hint. aria-disabled + intercepted activation is the accepted a11y pattern. Verified working end-to-end (attributes present in DOM, announcements on message change) in the onboarding flow.

**How to apply:** Any new inline error/status message → reuse ErrorBox or its role/live-region/iOS-announce trio (relevant to the Undo/View snackbar a11y work). Any new gating button → prefer the intercept-and-explain pattern over a dead disabled button; for onboarding steps just pass `nextBlockedHint` to `OnboardingFrame`.
