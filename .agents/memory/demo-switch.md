---
name: Guided demo removed (no demo entry anywhere)
description: The demo entry points and THINNR_DEMO switch are gone from web and mobile, and mobile demo code is fully deleted; rules for the remaining web seed modules, signed-out frames, suites and API grounding.
---

The guided demo was switched off in the published app (Oct 2026) and its ENTRY points were deleted on 2026-10-08: web demo chooser + sessionStorage persona, MenuLab, the `THINNR_DEMO` / `VITE_THINNR_DEMO` / `EXPO_PUBLIC_THINNR_DEMO` switch, mobile persona cards, the signed-out provider dashboard, `/claim-test`, `useDemoLabels`, and the anon `is_demo` training read policies. Do NOT re-add a demo door or a switch.

**Why:** the user asked for the demo code to go once production had no demo. Deleting it entirely was staged because ~80 web and ~25 mobile hermetic suites still use the demo dataset as their baseline, and the API's tokenless coach/scan paths still ground on the demo patient.

**Mobile has no demo seam left:** the patient account kind is `real | signed-out | unresolved`; sample rows for hermetic suites live under the mobile `scripts/fixtures/` directory and are test-only (app code must never import them); a lint-style check fails the build if the word "demo" reappears in user-visible mobile copy (fixture ids may still contain it).

**Rules:**
- Nobody signed out reaches an office/HQ screen or a patient route. Web: `persona === null` renders sign-in, /hq-setup or the course preview; mobile patient layout admits only `account.kind === 'real'`. Web seed modules and `authStatus !== 'signed-in'` branches are still DEAD UI code kept only as suite baselines — never wire a new screen to them.
- Signed-in screens never show demo labels, projections or seeded values; missing live data gets an honest empty or unavailable state (live-demo-ui-isolation.md).
- Mobile signed-out on a real-only surface = zero network and an honest frame: staff/billing screens hold their loading frame (`*-session-loading`, `leaderboard-signed-out`, billing resources stay `loading` so refresh controls never mount), shop/cart/checkout show `<prefix>-error` "Sign in". A signed-out mount must never look like a healthy empty list.
- Mobile hermetic suites must `setStubSession(null)` / sign out explicitly when they mean signed-out; rendering without a provider no longer yields sample data. Rewrite suites around real-account fixtures, never re-gate demo copy.
- Training: the mobile snapshot query is enabled only for a resolved, unlocked provider_staff session; signed out = a sign-in holding card and ZERO Supabase calls (the suite asserts no table reads). Web anonymous callers read an EMPTY roster/completions/invites; `is_demo` is a legacy seed marker only. Suites must not require seeded demo learners to exist.
- Server AI routes: a signed-in patient is grounded on their own account, failed account load = honest 502. Tokenless callers still get demo grounding; closing signed-out AI access (and then deleting `coach/demo-patient.ts`) is a separate follow-up that must rewrite the tokenless API suites.
- Public signed-out web pages: training share link / course preview, /pay, cancel links, /security/report, /hq-setup, /claim-account, /email.

**How to apply:** when touching a seed module or a demo branch, delete it if nothing but dead UI references it; when a suite depends on it, rewrite the suite around a real-account fixture in the same change.
