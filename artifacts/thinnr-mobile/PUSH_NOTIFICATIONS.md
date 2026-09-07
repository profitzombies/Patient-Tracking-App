# Push notifications

Remote push requires a physical device and an EAS development or production
build. Set `EAS_PROJECT_ID` to the Expo project id before bundling. No
`npx expo prebuild` step is required. Create and install a development build
with:

```sh
eas build --profile development
```

Sign in as a real patient. The Account screen should report **Push on this
device: Registered**. Expo Go, web, simulators, and builds without a project id
instead show their honest unavailable state.

To ask the server notification worker to process its outbox immediately:

```sh
curl -X POST "https://YOUR_API_HOST/internal/notifications/tick" \
  -H "Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

For production launch, upload an APNs key and an FCM v1 service account through
`eas credentials`. `EXPO_ACCESS_TOKEN` is optional and enables Expo enhanced
push security when configured on the project.

Server environment controls:

- `NOTIFICATIONS_INTERNAL_TOKEN`: protects the internal tick endpoint.
- `EXPO_ACCESS_TOKEN`: optional enhanced push-security credential.
- `NOTIFICATIONS_TICK_MS`: outbox interval; defaults to 30000.
- `NOTIFICATIONS_OUTREACH_EVERY_MS`: outreach evaluation interval; defaults to
  900000.
- `NOTIFICATIONS_DISABLED`: disables notification processing when enabled.