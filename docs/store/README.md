# Store listing kit — App Store and Google Play

Everything the person submitting THINNR to Apple and Google pastes into
App Store Connect and the Play Console, plus the reviewer access path and the
real-phone verification record. Build mechanics (EAS, TestFlight, internal
testing, submission clicks) live in [`../mobile-release.md`](../mobile-release.md);
this folder is the content and the proof.

| File | What it holds | Pasted where |
| --- | --- | --- |
| [reviewer-accounts.md](reviewer-accounts.md) | How the App Review office and the two reviewer identities work, the production variable, the reset command | Internal (THINNR ops) |
| [reviewer-notes.md](reviewer-notes.md) | The notes reviewers read, with credential placeholders and step-by-step paths to every gated feature | App Store Connect → App Review Information; Play Console → App access |
| [listing-copy.md](listing-copy.md) | Name, subtitle, descriptions, keywords, promotional text, what's new, category, URLs | Both listings |
| [age-rating.md](age-rating.md) | Apple age-rating questionnaire answers and Play content-rating (IARC) answers | Both consoles |
| [privacy-answers.md](privacy-answers.md) | App Privacy (Apple) and Data safety (Google) answers, audited against the API routes and SDKs the app ships | Both consoles |
| [health-justification.md](health-justification.md) | HealthKit review note and Health Connect declaration text | App Review note; Play Console → Health Connect declaration form |
| [tap-to-pay.md](tap-to-pay.md) | Tap to Pay on iPhone note for review and the entitlement status | App Review note |
| [medical-disclaimer.md](medical-disclaimer.md) | The disclaimer wording for both listings and the in-app consent | Both descriptions; Play health-apps declaration |
| [screenshots.md](screenshots.md) | Shot list per device size, which account to use, what must be visible | Both listings |
| [device-verification.md](device-verification.md) | The real-iPhone and real-Android checklist with a dated results record | Internal; attach to the release ticket |

## Order of operations

1. **Reviewer access** — follow [reviewer-accounts.md](reviewer-accounts.md):
   create the App Review office, enroll the reviewer patient, run the
   `mark-office` and `reset-patient` commands, set `APP_REVIEW_SIGN_IN` on the
   published deployment, sign in once yourself with the fixed codes.
2. **Test links into HQ** — once TestFlight and Play internal testing have a
   build, paste the TestFlight public link and the Play opt-in link into
   HQ → Organization settings → *App Store link* / *Google Play link*
   (`/admin/org-settings`). Patient invitation emails, the office "Get the
   app" QR codes and the launch-readiness *Patient app link* check switch to
   them immediately. Replace with the public listing links after approval.
3. **Real phones** — walk [device-verification.md](device-verification.md)
   on one iPhone and one Android with a `preview` build and fill in the
   record. Open a task for anything that fails before submitting.
4. **Listings** — paste from the files above, upload screenshots, answer
   privacy / age / health forms, attach the reviewer notes, submit.

## Facts the kit is derived from

- Bundle id / package: `com.thinnr.app`; version `1.0.0` (`artifacts/thinnr-mobile/app.json`).
- Sign-in: every identity gets a one-time code (SMS or email); patients also
  have a password; office staff may be asked for a texted second factor.
  Reviewer identities are the only exception (fixed code, never sent).
- Enrollment is invitation-only: a patient must be invited by an office.
- Native modules in the store build: camera, image picker, media library,
  motion sensors, audio playback (no microphone), notifications, local
  authentication (Face ID / fingerprint), secure store, HealthKit
  (read weight + steps), Health Connect (read weight + steps), Stripe
  card form. Stripe Terminal / Tap to Pay is compiled in only when
  `TAP_TO_PAY_ENABLED=1` (not in the first store build).
- No advertising, no tracking SDK, no third-party analytics, no crash
  reporter. Usage analytics are first-party and tied to the patient's record.
