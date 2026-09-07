# Native device features

Remote push registration, deep links, delivery-open tracking, and development
build setup are documented in [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md).

Medication notifications use `expo-notifications`; biometric convenience uses
`expo-local-authentication` plus account-scoped `expo-secure-store` state.
Apple Health (`react-native-health`) and Android Health Connect
(`react-native-health-connect`) request read-only access to **weight and steps**
and import at most the latest 30 days to the authenticated patient endpoint.

HealthKit and Health Connect contain custom native modules and therefore do not
work in Expo Go or on web. Use a native development/production build generated
by the project's normal Replit/Expo Launch build flow after installing pods and
prebuilding native configuration. Notification and biometric behavior must also
be verified on physical devices; simulators may not have enrolled biometrics,
and users can deny permissions in system Settings.

Biometrics never mint or replace a server session and never bypass password or
second-factor policy.

## Medication reminders

Local reminders are derived from the patient's medication list (the same
records the office sees), never from free-standing alarm times:

- Every medication row becomes one schedule per dose time. Daily records use a
  `DAILY` trigger; weekly records (GLP-1 injections) use a `WEEKLY` trigger on
  the record's weekday (Expo counts Sunday as 1, the record counts Sunday as
  0). Stopped records and records that start in the future schedule nothing.
- The notification names the medication and dose ("GLP-1 injection · 0.5 mg")
  and carries the medication id and due time. Its category offers **Taken**
  and **Skip** actions; either action logs that dose for the local day the
  reminder fired on, then the app opens on the check-in screen's "Today's
  medications" card where the dose now shows and can be corrected (7-day
  window); a plain tap opens the same card without logging. The actions
  foreground the app deliberately: there is no background notification task,
  so a background-only action would be dropped while the app is suspended.
- Reconciliation is a signature diff of the whole plan (record ids, times,
  weekdays, the device timezone, and the account). It runs when the list
  changes, when the app becomes active, and on account switch; signing out
  or changing patient accounts cancels the old account's identifiers first.
  Turning reminders off cancels everything but keeps the medication list.
- Onboarding seeds the list: the THINNR protocol becomes one daily record with
  the three chosen dose times; a GLP-1 program becomes one weekly record on
  the injection day the patient picks. Later edits happen in Account →
  Medications.
- Missed doses are backed up server-side: if a dose is still unlogged after
  the configured delay, the notification outbox sends a check-in reminder
  (respecting quiet hours, categories, and the daily cap).

## Native smoke check

Run `pnpm --filter @workspace/thinnr-mobile test:device-features` before making
development builds. Then verify on one physical iPhone development build and
one Android development build:

1. Deny notification permission, confirm Settings guidance, then grant it.
2. With a daily medication (three times) and a weekly injection on record,
   enable reminders and confirm exactly four schedules named after the
   medications; edit one time and confirm the count is unchanged; stop a
   medication and confirm its schedules go away; disable reminders and
   confirm none remain.
2b. Long-press (Android) / pull down (iOS) a fired reminder and choose
   **Taken** with the app backgrounded; confirm the app opens on the check-in
   card with the dose taken and the office record agrees. Force-quit the app,
   choose **Skip** on the next reminder, and confirm the cold start still
   logs it. Tap a third plainly and confirm the card opens with nothing
   logged.
3. Enable biometrics, background/foreground the app, and confirm only an
   enrolled biometric unlocks it; normal sign-in remains available.
4. Switch accounts while a biometric prompt or health permission sheet is open
   and confirm the old operation is discarded.
5. Grant only the requested weight and steps permissions, import, revoke a
   permission, and confirm the app reports the denial without importing.
6. Change the device timezone and foreground the app; confirm reminder wall
   times stay the same in the new timezone.

These checks intentionally cannot pass in Expo Go or on web because HealthKit
and Health Connect are custom native modules. Those targets must show disabled,
explicitly unavailable controls instead.