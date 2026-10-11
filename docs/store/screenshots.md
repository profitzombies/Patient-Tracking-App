# Screenshot shot list

Take every shot on the **reviewer patient / reviewer staff accounts** right
after `reset-patient` (see [reviewer-accounts.md](reviewer-accounts.md)), so
the diary, chart and roster carry the sample history and no real patient is
visible. Light appearance, system font size default, status bar showing a
full battery and 9:41 (Xcode simulator does this; on Android use the
Developer option "Demo mode").

## Required sizes

| Store | Device slot | Pixel size | Source device / simulator |
| --- | --- | --- | --- |
| Apple | iPhone 6.9" (required) | 1320 × 2868 | iPhone 16 Pro Max simulator |
| Apple | iPhone 6.5" (optional once 6.9" exists; keep for older listing surfaces) | 1284 × 2778 | iPhone 11 Pro Max / 14 Plus simulator |
| Apple | iPad 13" (only if the app declares iPad support — `app.json` has `supportsTablet: false`, so **skip**) | — | — |
| Google | Phone (2–8 required) | 1080 × 2400 (9:16–9:19.5) | Pixel 8 emulator |
| Google | 7" tablet, 10" tablet | Not required when the listing is phone-only; skip |
| Google | Feature graphic (required) | 1024 × 500 PNG/JPG, no transparency | Export: `assets/images/store/adaptive-foreground.png` centred on the `#203b64` field used by the adaptive icon |
| Google | App icon | 512 × 512 PNG | Export from `assets/images/store/icon-ios.png` (1024²) at 512² |

Capture with `xcrun simctl io booted screenshot` / `adb exec-out screencap`
at native resolution; do not upscale. Apple accepts up to 10 shots per
size, Google up to 8.

## The eight shots (same order on both stores)

| # | Screen | Account | How to get there | Must be visible | Must NOT be visible |
| --- | --- | --- | --- | --- | --- |
| 1 | **Today** | Patient | Sign in → Today | Greeting, phase card, water tracker, today's partial diary totals | Real names (reviewer patient is named for the office) |
| 2 | **Diary** | Patient | Diary tab | Full day with breakfast/lunch/dinner entries, macros, fit badges | — |
| 3 | **Log food — search** | Patient | Diary → Log food → type "salmon" | Results with approved badge, "More ways to add" row | Keyboard suggestions bar with personal words |
| 4 | **Coach** | Patient | Coach tab → ask "What should I order at a Mexican restaurant?" | A finished reply citing the plan | Anything resembling medical/dosing advice; the photo button is fine |
| 5 | **Progress** | Patient | Progress tab | Weight chart with the three sample check-ins trending down, Bloodwork and Guided photos entries | Body photos |
| 6 | **Account — Device features** | Patient | Avatar → Account, scroll to Device features | "Enable biometric unlock", "Connect health data" with Apple Health / Health Connect wording for the platform being shot | Email address of the reviewer mailbox (scroll past Profile) |
| 7 | **Staff — Patients roster** | Staff | Provider login → Patients tab | Roster rows (the reviewer patient plus any sample patients you add to the review office), activity columns, Flagged filter | Any non-review-office patient |
| 8 | **Staff — Sell to patient** | Staff | Payments tab → Sell to patient → pick a product | Product, price, "Card" payment choice | Tap to Pay button (not in build); any Live-mode badge |

Optional 9–10 (Apple only): **Medications** (Account → Medications with a
sample named "Vitamin D 2000 IU, every morning" — never a prescription
drug name) and **Care-team chat**.

## Captions (overlaid in the frame template, ≤ 40 characters)

1. Your day at a glance
2. Log every meal in seconds
3. Approved foods, flagged for your phase
4. A coach that knows your plan
5. See your progress, week by week
6. Health, Face ID and reminders — your call
7. For clinics: every patient, one roster
8. Take payments in the room

Captions use Playfair Display (the app's display face) on the cream panel
with the cobalt device frame, matching the app's heritage palette; no
gradients, no emoji, no star ratings.

## Platform differences to re-shoot, not reuse

- Shot 6: iOS says "Apple Health", Android says "Health Connect" — shoot
  on each platform.
- Shot 8: iOS and Android card sheets differ (Stripe PaymentSheet); shoot
  each.
- Everything else can be shot once per platform at that platform's size;
  do not place an iPhone frame on the Play listing or vice versa.

## Review-safe checklist before upload

- [ ] No real patient, staff name, email, phone or office other than
      "App Review".
- [ ] No prescription drug names, no weight-loss claims in captions.
- [ ] Stripe shows **Test** data only (4242 card, "TEST" badge is
      acceptable in the staff shot but crop it if the frame allows).
- [ ] Status bar clean (no carrier name, no notifications).
- [ ] Each image is the exact pixel size from the table (consoles reject
      off-by-one sizes).
