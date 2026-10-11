# Real-device verification record

Expo Go cannot run push delivery, HealthKit / Health Connect, Face ID, the
Stripe card sheet, Tap to Pay or the store-flavoured permission prompts, so
every item below must be confirmed on **one real iPhone and one real Android
phone running a `preview` build** (`docs/mobile-release.md` §3) against the
published API with `APP_REVIEW_SIGN_IN` set. Fill in every row before
submission; a blank row is a blocker, a failed row becomes a task.

## Record

| Field | iPhone | Android |
| --- | --- | --- |
| Device model / OS version | | |
| Build (EAS build id, profile `preview`, app version 1.0.0, runtime) | | |
| API deployment (`app.trythinnr.com` release / date) | | |
| Tester (name) and date | | |
| Reviewer patient signed in with fixed code (no SMS/email arrived) | ☐ pass ☐ fail | ☐ pass ☐ fail |
| Reviewer staff signed in with fixed code, no SMS second step | ☐ pass ☐ fail | ☐ pass ☐ fail |
| HQ → Audit shows `app_review_sign_in` rows for both | ☐ pass ☐ fail | ☐ pass ☐ fail |

Mark each item **pass / fail / n/a** with a one-line observation and the
date. Items are grouped by what the app asks of the phone.

### P — Push notifications

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| P-1 | Permission prompt appears once, from the Account screen, not at launch | Fresh install → sign in → no prompt. Account → Notifications → Enable medication reminders → OS prompt | | |
| P-2 | Device token registered | HQ → System health → Push shows the device; or office patient record → Notifications timeline | | |
| P-3 | Reminder delivered with the app closed | Account → Medications → add "Vitamin D", reminder 2 minutes ahead → kill app → notification arrives → tap → app opens on the dose action | | |
| P-4 | Care-team message push | From the web office inbox send a message → push arrives → tap opens the chat | | |
| P-5 | Staff alert push (staff account) | Trigger a flagged patient (e.g. missed check-ins on a sample patient) → staff device receives the digest/alert | | |
| P-6 | Quiet hours respected | Set office quiet hours covering now in HQ policy → no push; outside → push | | |

### H — Apple Health / Health Connect

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| H-1 | Permission sheet lists exactly Weight and Steps, read only | Account → Device features → Connect health data | | |
| H-2 | Import works | Add a weight sample in Health / Health Connect dated yesterday → Connect → Progress shows the imported point with the "from Health" source | | |
| H-3 | Health Connect rationale opens the privacy page (Android) | Health Connect app → THINNR → "Read privacy policy" opens the policy URL | n/a | |
| H-4 | Denied permission handled | Deny → app shows the inline "not connected" state, no crash, can retry from Settings | | |
| H-5 | Health Connect not installed (Android < 14 or removed) | Button shows the install/update prompt, not a crash | n/a | |

### C — Camera, photos, motion

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| C-1 | Meal photo from camera | Corner button → Snap a meal photo → take photo → coach reply logs a plate | | |
| C-2 | Meal photo from library (limited photo access on iOS) | Choose from library with "Select photos…" limited access → works | | |
| C-3 | Barcode scan | Corner button → Scan a barcode → real packaged product → food found | | |
| C-4 | Nutrition label scan | Log food → More ways to add → Scan barcode → Scan a label instead → label photographed → food created | | |
| C-5 | Guided photos tilt | Corner button → Progress photos → tilt bar responds to gravity; level turns green; capture succeeds; motion permission prompt appears on iOS | | |
| C-6 | Guided photos with motion denied (iOS) | Deny motion → surface explains and offers Settings; no silent green | | n/a |
| C-7 | Lab report via camera and via PDF | Progress → Bloodwork → add report (camera) and (Files PDF) → values appear for staff | | |
| C-8 | Camera denied | Deny camera → surface shows the denied fallback inside the camera route | | |

### B — Biometrics

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| B-1 | Enable Face ID / fingerprint unlock | Account → Device features → Enable biometric unlock → OS prompt → enabled | | |
| B-2 | Lock on foreground | Background 10 s → foreground → biometric prompt → success opens the app on the same screen | | |
| B-3 | Biometric failure / cancel | Cancel the prompt → app stays locked, offers retry and Sign out, never shows data | | |
| B-4 | Face ID usage string correct | iOS prompt text is "THINNR uses Face ID only to unlock the signed-in app on this device." | | n/a |

### S — Stripe (Test mode)

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| S-1 | Patient checkout with card sheet | Shop → add product → Checkout → 4242 4242 4242 4242 → order confirmed → Orders shows it; office Payments shows the order | | |
| S-2 | Declined card | 4000 0000 0000 0002 → inline decline, cart intact | | |
| S-3 | 3-D Secure challenge | 4000 0025 0000 3155 → challenge sheet → completes | | |
| S-4 | Staff "Sell to patient" card payment | Payments → Sell to patient → pick reviewer patient → product → card → paid; receipt email arrives at the reviewer mailbox | | |
| S-5 | Bank account verification (office access) — web | On the operations site as the review office owner: **Account & billing** (`/account`) → payment method → Bank account → Stripe test bank `000123456789` / routing `110000000` → micro-deposit or instant verification completes and the instrument shows **verified** | n/a (web) | n/a (web) |
| S-6 | Subscription renew/pause | Subscriptions → pause → resume; office sees state | | |
| S-7 | Tap to Pay absent | Payments → Sell to patient shows no Tap to Pay option in this build | | |

### A — Account lifecycle

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| A-1 | Deletion request | Account → Privacy & data → Close my account… → confirm → banner shows the grace period and date; office roster shows the pending closure | | |
| A-2 | Cancel deletion | Keep my account → banner clears; office state back to active | | |
| A-3 | Data export | Request my data → email with link → archive downloads and opens | | |
| A-4 | Sign out everywhere else | Sign in on both phones → on one: Account → Security → Sign out everywhere else → Confirm → the other phone is signed out on its next request and shows the holding frame | | |
| A-5 | "This wasn't me" link from the sign-in email | Tap the link in a real sign-in email → security page → sign out everywhere → all devices out | | |
| A-6 | Reviewer reset command | `reset-patient --apply` → sign out/in → 14 days of diary, chart trend visible | | |
| A-7 | Session survives app restart and offline start | Kill app, airplane mode, open → still signed in, offline queue works, sync chip after reconnect | | |

### L — Store links and invitation

| # | Check | Steps | iPhone | Android |
| --- | --- | --- | --- | --- |
| L-1 | HQ store link saved | HQ → Organization settings → App Store link = TestFlight public link, Google Play link = internal-testing opt-in link → Save | | |
| L-2 | Invitation email uses them | Office → Patients → Invite patient (a THINNR mailbox) → email's install button opens TestFlight / Play opt-in | | |
| L-3 | Office QR code | Office → Settings → *Get the app* QR → scanning on the phone opens the same link | | |
| L-4 | Launch readiness check green | HQ → System health → *Launch readiness* card → "Patient app link" passes | | |

## Results log

Append one entry per session; never overwrite earlier ones.

```
Date:        YYYY-MM-DD
Tester:
iPhone:      model, iOS, build id
Android:     model, Android, build id
Failures:    (item ids, one line each, task link)
Notes:
```

## Follow-ups opened

| Item | Task | Status |
| --- | --- | --- |
| | | |
