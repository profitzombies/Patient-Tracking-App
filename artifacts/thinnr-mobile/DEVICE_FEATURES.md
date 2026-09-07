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
second-factor policy. Signing out or changing patient accounts cancels the old
account's local reminder identifiers. Reconciliation also runs when the app
becomes active, replacing schedules when the timezone changes.

## Native smoke check

Run `pnpm --filter @workspace/thinnr-mobile test:device-features` before making
development builds. Then verify on one physical iPhone development build and
one Android development build:

1. Deny notification permission, confirm Settings guidance, then grant it.
2. Enable three reminders, edit one time, and confirm exactly three schedules;
   disable reminders and confirm none remain.
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