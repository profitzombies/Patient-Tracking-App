# Mobile scroll boundaries

## Scope and layer

The Today hero, including its wordmark, is content inside the page's vertical
ScrollView. It must scroll away normally. No hero, safe-area, navigation,
typography, or fit-canvas dimensions were changed.

Ordinary vertical pages and lists use `components/ui/PageScrollView.tsx`;
forms receive the same policy from `KeyboardAwareScrollViewCompat`.
`scrollBoundary.ts` controls native iOS bounce, Android edge effects, and the
web overflow element separately. `WebFitShell` also contains document-level
overscroll, including when canvas scaling is disabled. It uses no touch
cancellation and does not change document dimensions or modal portals.

Exceptions:

- Bloodwork history and the live staff roster explicitly request the refresh
  policy. iOS bounce remains enabled on those two lists, including short lists.
  Android's RefreshControl is preserved separately from its edge effect.
- Horizontal lists retain their own native defaults.
- Coach, support, and care-team chat scrolling is unchanged.
- PhotoLightbox, ZoomableImage (both axes), and guided camera/photo sheets keep
  their specialized scroll/gesture handling.

## Verification recorded 2026-09-10

### Expo web (Chromium, touch-enabled, actual Expo domain)

This is **not native iOS, Android, or Safari evidence**.

The browser used CDP `Input.dispatchTouchEvent` with touchStart, touchMove, a
held touch, and touchEnd, rather than wheel events or DOM-only event dispatch.

- At 393×852, Today stayed at scrollTop 0 during a held downward pull. The
  scrolling element had scrollHeight 1925 and clientHeight 852, with computed
  overscroll-behavior-y `none`. Window, html, and body offsets stayed 0.
- An ordinary upward touch reached Today's bottom at 1073 = 1925 − 852.
  The hero scrolled away; the final disclaimer and floating navigation were
  visible, with no blank overscroll area.
- At 375×667, the **visible** Today wordmark had a positive bounding rect:
  x 19.08397, y 88.26336, width 116.42712, height 31.48855. After three
  repeated downward pulls, measured while held, that rect was identical.
  Its actual overflow ancestor stayed at scrollTop 0; all document offsets
  stayed 0. The fixed layout canvas remained scaled from 393 layout pixels.
- Diary top and Library's no-results state stayed bounded during held pulls.
- Library and Plan opened through the existing FAB. Progress, Coach, and the
  FAB menu remained usable.
- The check-in form focused its notes field and scrolled to the lower controls
  (scrollTop 297, scrollHeight 921, clientHeight 624); an unsaved draft was
  entered, cleared, and canceled.
- The Progress chart received a horizontal touch without layout/navigation
  breakage. The tested plot fit its container, so this is not proof of
  horizontal movement on an overflowing chart.
- Bloodwork's empty demo history opened. No refresh request, report upload,
  patient write, or chat send was performed.

The initial broad DOM query also matched hidden mounted tab content and
returned an unusable zero logo rect. Only the positive visible-logo measurement
above counts as quantitative held-logo evidence. The Plan page's initial
ancestor measurement was its frame, not proof that all Plan content fits.

### Automated component checks

`pnpm --filter @workspace/thinnr-mobile run test:scroll-boundary` exercises
the platform policy, actual wrapper forwarding, real screen adoption,
refresh exceptions, and web document-style lifecycle. Native host stubs
prove prop forwarding, **not native gesture physics**.

All 166 checks passed, including executed policy/wrapper mutations and an
isolated Today adoption mutation. Two concurrent web shells were mounted to
prove closing a modal's shell cannot remove the root shell's document policy.

The following affected existing mobile suites passed:
patient-fab, onboarding-hints, library-sync, account-progress,
invite-patients, leaderboard, bloodwork, guided-photos, coach-stop,
care-team-chat, food-detail, and provider-training.

Mobile typecheck passed after refreshing the existing API client's stale
project-reference declarations. No API source was changed.

## Outstanding native-device verification

No native iOS/Android device or simulator runner was available in this Linux
workspace. The original native pull was not independently reproduced.
Native held-pull, refresh, keyboard, dismiss, and photo-gesture behavior
therefore remains **unverified**, rather than inferred from Chromium.

On an iPhone and an Android phone, record device/OS/Expo versions and check:

1. Today at the top: repeat downward pulls and hold each one before release.
   The wordmark/hero must not move or expose a blank band.
2. All five tabs: reach the bottom and return to the top, including a short
   no-results Library state. The hero must scroll away, not become sticky.
3. A keyboard-aware form: focus a lower field with the software keyboard
   visible, scroll, tap controls, and dismiss without saving.
4. Bloodwork history and an authorized live staff roster: pull to refresh on
   both short and long lists and confirm the real refresh callback completes.
5. Horizontal overflow, chat scroll/input, native modal dismissal, photo paging,
   and zoom/panning must remain functional. Confirm fixed bottom navigation
   and safe areas at reference and short phone sizes.

Also outstanding: physical Safari browser overscroll, native modal swipe
dismissal, overflowing chart movement, and report photo zoom/pan. The demo
browser pass did not have an authorized staff roster or an uploaded report.