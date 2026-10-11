# Releasing the THINNR patient app to the App Store and Google Play

This guide is for whoever owns the THINNR release, engineer or not. It walks
through everything from the one-time account setup to shipping a bug fix
without a store review. Commands are run from the project root in the Replit
Shell (or any terminal with the project checked out). Nothing here needs code
changes; everything the build needs is already in the repository.

The patient app lives in `artifacts/thinnr-mobile`. Builds are made by **EAS**
(Expo Application Services), Expo's hosted build and update service, so no Mac
or Android Studio is required.

---

## 0. One-time prerequisites (owner actions)

These cannot be done from the code base. Each stops the step that needs it
until it is in place.

| What | Why | Where |
| --- | --- | --- |
| **Apple Developer Program** enrollment for the company (requires a D-U-N-S number; takes days to weeks) | Required to upload any iOS build, use TestFlight, and publish on the App Store. | developer.apple.com/programs |
| **Google Play Console** developer account (one-time fee, identity verification) | Required to upload any Android build and publish on Google Play. | play.google.com/console |
| **Expo account** (an organization account is best, so the project is not tied to one person) | EAS builds, over-the-air updates and push-notification credentials are managed here. | expo.dev |
| **Apple App Store Connect app record** with the bundle id `com.thinnr.app` | The iOS listing. EAS can create it for you on the first `eas submit`. | appstoreconnect.apple.com |
| **Google Play app record** with the package name `com.thinnr.app` | The Android listing. Google requires the *first* Android bundle to be uploaded by hand in the Play Console; EAS can submit every later one. | Play Console → Create app |

Identifiers already fixed in the repository (do not change them once the
first build has been uploaded — the stores treat a new id as a new app):

- iOS bundle identifier: `com.thinnr.app`
- Android package: `com.thinnr.app`
- Expo slug: `thinnr`
- URL scheme: `thinnr://`

### Secrets and environment variables

No credential is ever committed. Everything below is entered in the Expo
dashboard (**expo.dev → your project → Environment variables**) or in Replit
Secrets, as noted.

| Variable | Where | Used for |
| --- | --- | --- |
| *(Project ID)* | `app.json` → `extra.eas.projectId`, written once by `eas init --id …` (section 1) and committed | Expo project id. Flows into the app config (`extra.eas.projectId`) so push-token registration and over-the-air updates know which project they belong to. It is public (every phone sees it in the update URL), not a credential. Shown on the project's page at expo.dev as **Project ID**. |
| `EAS_PROJECT_ID` | EAS environment variable (optional) | Override for the project id above, only if you ever need a build or update to target a different Expo project without editing `app.json`. Not needed once `eas init` has run. |
| `EXPO_OWNER` | EAS environment variable (optional), same three environments | The Expo account/organization name that owns the project. Only needed when the build token belongs to a different account. |
| `EXPO_PUBLIC_SUPABASE_URL` | EAS environment variable, in **each** of the three environments | The production Supabase project URL the app signs in against. |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | EAS environment variable, in **each** of the three environments | The production Supabase publishable (anon) key. Safe to ship inside the app; never the service-role key. |
| `EXPO_TOKEN` | Replit Secret (for running `eas` from the Replit Shell or CI) | A personal or robot access token from expo.dev → Account settings → Access tokens. Lets `eas` commands run without an interactive login. |
| `TAP_TO_PAY_ENABLED` | Set to `1` in the **development** profile only (already in `eas.json`) | Adds the Apple Tap to Pay entitlement and the Stripe Terminal module. Leave off for store builds until Apple has granted the entitlement (section 7). |

`EXPO_PUBLIC_DOMAIN` is **not** a secret: it is pinned to `app.trythinnr.com`
in `eas.json` for every profile, so a store build can only ever talk to the
published API. The Replit workspace preview address is never built in.

**EAS environments.** expo.dev keeps three named sets of environment
variables — `development`, `preview` and `production`. Each build profile in
`eas.json` names the environment it loads (`"environment": "production"` for
the production profile, and so on), so a build and an over-the-air update for
the same profile always see the same variables. Enter the three variables
above in **all three** environments (expo.dev → project → Environment
variables → pick the environment → Add variable; visibility *Plain text* is
fine for all of them — none is secret). Leaving one environment empty does not
break the build command; it produces an app that cannot sign in, which is why
the release script (section 7) checks the environment before publishing.

The two Supabase variables are the only ones that must live in the EAS
environments; the project id is committed in `app.json`.

---

## 1. Connect the project to EAS (first time only)

1. Install the EAS command line once:
   `pnpm add -g eas-cli` (or use `npx eas-cli` in front of every command below).
2. Sign in: `eas login` (or set `EXPO_TOKEN` and skip this).
3. Create the project on expo.dev once: **expo.dev → Projects → Create a
   project**, name it `thinnr` (the slug in `app.json`). The project page
   shows its **Project ID** (a long id with dashes).
4. From `artifacts/thinnr-mobile`, link this checkout to that project and
   write the id into `app.json`:
   `eas init --id <Project ID>`
   (add `--non-interactive` when running from a script with `EXPO_TOKEN` set).
   This is the only time `app.json` is edited by a tool: it gains
   `extra.eas.projectId`. **Commit that change** — every later build and
   over-the-air update reads the id from there, and the release script
   stops early on a checkout that does not have it. The id is
   public; committing it is safe and expected.
5. Enter the two Supabase variables from the table above in each of the
   `development`, `preview` and `production` EAS environments.
6. Confirm the config resolves without warnings:
   `pnpm --filter @workspace/thinnr-mobile run check:store-config`
   (runs `expo config`, `expo-doctor`, and the store-settings assertion test;
   it also accepts the committed project id and rejects anything else under
   `extra.eas`).

### Build profiles (already configured in `eas.json`)

| Profile | What it is for | Who installs it | Updates channel / EAS environment |
| --- | --- | --- | --- |
| `development` | Developer build with the dev client; includes Tap to Pay for testing. | Engineers, via a direct link. | `development` |
| `preview` | Internal test build (Android APK, iOS ad-hoc). Exactly the production app but installable without the stores. | Staff phones registered as test devices. | `preview` |
| `production` | The store build (Android App Bundle, iOS App Store). Version and build numbers are assigned by EAS (`appVersionSource: remote`, auto-increment). | TestFlight / Play internal testing, then the public stores. | `production` |

The channel decides which phones receive an over-the-air update; the EAS
environment of the same name supplies the variables the bundle is built
with. They are deliberately identical per profile.

Every profile pins the same Node and pnpm versions the workspace uses, so the
build environment matches local checks.

---

## 2. Register test devices (iOS only, for `preview` builds)

Apple only lets an ad-hoc build run on devices whose ids are on the
provisioning profile.

1. `eas device:create` — prints a link/QR code. Open it on each test iPhone and
   follow the prompt; the device registers itself.
2. Any later `preview` iOS build includes every registered device. Add a
   device → make a new preview build.

Android needs nothing: the APK installs on any phone that allows "Install
unknown apps".

---

## 3. Push-notification credentials

Push notifications in a store build need credentials that Expo Go provided
for you until now. EAS stores them; nothing goes in the repository.

**iOS (APNs key)**

1. Run `eas credentials` from `artifacts/thinnr-mobile`, choose **iOS →
   production → Push Notifications: Manage your Apple Push Notifications Key**.
2. Let EAS create a new key in your Apple account (recommended) or upload an
   existing `.p8`. One key serves every app on the account.

**Android (FCM V1)**

1. In Firebase console create a project (or reuse one), add an Android app
   with package `com.thinnr.app`, and under Project settings → Service accounts
   generate a **service account JSON** key.
2. `eas credentials` → **Android → production → Google Service Account Key for
   FCM V1** → upload the JSON. EAS keeps it; do not add it to the repo.

**How the pieces connect** — the app asks Expo for a push token using the
project id from `app.json` (`extra.eas.projectId`, written by `eas init`),
sends the token to the THINNR API, and the API's existing
push outbox delivers through Expo's push service with the credentials above.
No API change is needed.

**Proving it on a real phone** — install a `preview` build on a staff phone,
sign in as a test patient and allow notifications, then have a staff member
send that patient a care-team message from the office Inbox (any patient push
the API already sends works: care-team messages, medication reminders, order
updates). The notification should arrive within a minute with the app closed. On the
dashboard, the patient's record (Patients → the patient → *Coach outreach*)
lists the push with its delivery status, and HQ → System health → *Patient
push outbox* shows the queue draining. Do this once before the first store
submission and after any change to the APNs/FCM credentials.

---

## 4. Running a build

From `artifacts/thinnr-mobile`:

```
eas build --profile preview --platform all        # internal test build
eas build --profile production --platform all     # store build
eas build --profile development --platform ios    # dev client (engineers)
```

- The first iOS build asks to create a **distribution certificate** and
  **provisioning profile**; answer "yes, let EAS manage them". They are stored
  on expo.dev.
- The first Android build generates an **upload keystore**; also managed by
  EAS. Never lose or regenerate it: Google ties the app to it. Download a copy
  with `eas credentials` → Android → Keystore → Download, and keep it in the
  company password manager.
- Builds take 10–25 minutes. The command prints a link where you can watch
  progress and download the result; the Expo dashboard lists every build.
- `eas build` requires a clean git working tree (`requireCommit: true`), so
  the build always corresponds to a commit you can find again.

Installing a **preview** build: open the build page on the phone and tap
*Install* (iOS) or download the APK (Android).

---

## 5. TestFlight and Google Play internal testing

**iOS — TestFlight**

1. `eas submit --profile production --platform ios --latest`
   uploads the latest production build to App Store Connect. The first run
   asks for an App Store Connect API key; let EAS create one.
2. In App Store Connect → TestFlight, add internal testers (team members) or
   create an external group and enable the **public link**. Processing takes
   10–30 minutes after upload.
3. Testers install the TestFlight app, open the link, and install THINNR.

**Android — internal testing**

1. The very first Android bundle must be uploaded by hand: download the `.aab`
   from the build page, then Play Console → Testing → Internal testing →
   Create release → upload → Save → Review release → Start rollout.
2. Later releases: `eas submit --profile production --platform android --latest`
   (the submit profile targets the internal track as a draft; roll it out in
   the Console). The first automated submit also needs a Play service account
   JSON; the command walks you through creating it.
3. Internal testing → Testers → copy the **opt-in link**. Testers open it once
   and then install from Google Play.

**Point patient invitations at the test builds.** As soon as you have a
TestFlight public link and a Play internal-testing opt-in link, enter them in
HQ → Organization settings → *App Store link* / *Google Play link*. From that
moment patient invitation emails, the office "Get the app" links and QR codes
and the launch-readiness "Patient app link" check all use them instead of the
Expo Go page. Replace them with the public listing links once the listings
are approved (section 6). A platform whose link is still blank keeps the Expo
Go page.

---

## 6. Submitting for review and publishing

Listing copy, screenshots, the App Privacy questionnaire and reviewer
accounts are a separate review-readiness task; this section only covers the
mechanics.

**iOS**

1. In App Store Connect → App → the version, attach the TestFlight build,
   complete the listing, answer *Export Compliance* (the app declares it uses
   only exempt encryption — `ITSAppUsesNonExemptEncryption = false` — so no
   documentation is needed), and *Submit for Review*.
2. Review usually takes 1–3 days. If rejected, the resolution center message
   says why; fix, build again (section 4) and resubmit.
3. Choose *Manually release* so you control the day it goes live.

**Android**

1. Promote the internal-testing release to **Production** in the Play
   Console (Testing → Internal → Promote release → Production), complete the
   store listing, content rating, data safety and target audience sections,
   then *Start rollout*. A staged rollout (e.g. 20 % → 100 %) is available.
2. First-time review takes up to 7 days.

After approval, paste the public listing links into HQ → Organization
settings. The invitation email then reads "Install from the App Store /
Google Play" for both platforms.

---

## 7. Shipping a fix without a store review (over-the-air updates)

Copy, layout and logic fixes written in JavaScript/TypeScript ship as an
**over-the-air (OTA) update**: the phone downloads the new bundle the next
time the app starts, no store review. Native changes cannot.

Always publish through the release script, from the project root:

```
pnpm --filter @workspace/thinnr-mobile run release:update preview --message "Fix: diary copy button"
pnpm --filter @workspace/thinnr-mobile run release:update production --message "Fix: diary copy button"
```

The first argument is the build profile. The script publishes to that
profile's channel **and** loads that profile's EAS environment, exactly as a
build would (`eas update --channel preview --environment preview` underneath),
after three checks, each of which stops the publish with a plain message:

1. the checkout is linked to the Expo project (`extra.eas.projectId` in
   `app.json`, section 1);
2. the EAS environment defines `EXPO_PUBLIC_SUPABASE_URL` and
   `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`;
3. a **finished build on that channel can actually run the update** — see the
   runtime version rule below. Without this check the underlying command
   publishes anyway, prints a warning, and no phone ever receives the fix.

Do not run the underlying command by hand: on its own it applies neither the
`eas.json` variables nor the EAS environment, and the resulting bundle cannot
reach the API or sign anyone in. The same script works with `EXPO_TOKEN` set
(no interactive login) and accepts any extra flag the underlying command
takes, for example `--platform ios` (the build check then covers iOS only).

- Updates go to the channel of the profile named; `production` reaches store
  installs, `preview` reaches preview builds. Always publish to `preview`
  first and open the app twice on a test phone (first start downloads, second
  start runs it) — check that you can sign in and open the diary, which proves
  the bundle carries its API origin and Supabase project.
- **Runtime version rule.** The app's runtime version is a fingerprint of its
  native code (`runtimeVersion.policy = "fingerprint"`). A phone only installs
  an update whose runtime version equals the one its build was made with. The
  underlying `eas update` command does **not** enforce this — it publishes to
  the channel regardless and merely warns — so the release script computes
  the fingerprint this checkout would produce and asks EAS for a finished
  build on the channel with that fingerprint. If there is none it stops with
  "no finished … build on the channel has runtime version …": that is your
  signal that a **store build is required instead** — see the table. (On a
  brand-new project whose first build is still running, `--skip-build-check`
  lets you publish anyway; phones receive it once the matching build exists.)

| Change | Ships as |
| --- | --- |
| Text, colours, layout, screen logic, API calls, bug fixes in `.ts`/`.tsx` files | OTA update (`release:update`) |
| Adding/removing/upgrading a package with native code (anything under `plugins` in `app.json`, Stripe, Health, camera, notifications), changing `app.json` / `app.config.js`, permission strings, icons, splash, Expo SDK upgrade, turning Tap to Pay on | **Store build** (`eas build --profile production`) then `eas submit` |

When in doubt, run `release:update preview`: if the fingerprint changed it
stops before publishing and tells you a store build is required instead. After
that store build is finished and installed, the same OTA command works again
for later JavaScript-only fixes.

**Rolling back an update.** On expo.dev → project → Updates → the
`production` channel: open the previous good update and choose
**Republish**. Phones pick it up on their next start. (Equivalent command,
from `artifacts/thinnr-mobile`: `eas update:republish --channel production`
and select the update. Republishing re-uses the bundle exactly as it was
published, so no environment is involved.)

**Rolling back a store build** is not possible in either store; publish a fix
instead. On iOS you can pause a phased release; on Android you can halt a
staged rollout from the Play Console.

---

## 8. Turning on Tap to Pay (later)

The first store submission deliberately omits the Apple *Tap to Pay on
iPhone* entitlement, because Apple grants it per app after a request and
rejects binaries that claim it beforehand.

1. Request the entitlement in the Apple Developer account (Certificates,
   Identifiers & Profiles → Identifiers → the app id → Additional
   Capabilities → Tap to Pay on iPhone), and complete Stripe's Tap to Pay
   enrollment.
2. Once Apple confirms, add `TAP_TO_PAY_ENABLED=1` to the `production` and
   `preview` profiles in `eas.json` (the `development` profile already has it).
3. Make a new store build; `eas credentials` will refresh the provisioning
   profile to include the capability. This is a native change, so it must go
   through the stores.

---

## 9. Checks that run automatically

- `pnpm --filter @workspace/thinnr-mobile run test:store-config` — resolves
  the real app config (with and without the Tap to Pay flag) and asserts the
  store-required settings: bundle id / package, icon and adaptive icon files,
  splash, every permission string, Health entitlements, the encryption
  exemption flag, the privacy manifest, the updates block and runtime policy,
  that Tap to Pay is absent unless the flag is set, that `eas.json` points
  every profile at the published API with no credential committed, that each
  profile names its EAS environment, and that the OTA release script and this
  guide always publish with that environment.
- `pnpm --filter @workspace/thinnr-mobile run check:store-config` — the above
  plus `expo config` and `expo-doctor` (21 project health checks, including
  package versions matching the Expo SDK and no duplicate native modules).
- The existing mobile suites and `typecheck` stay in the validation set.
- This guide is also readable in the dashboard: HQ → System health → *Provider
  launch readiness* → **Mobile release guide**.

---

## Quick reference

| I want to… | Run |
| --- | --- |
| Make an internal test build | `eas build --profile preview --platform all` |
| Make a store build | `eas build --profile production --platform all` |
| Upload to TestFlight / Play internal | `eas submit --profile production --platform <ios|android> --latest` |
| Ship a JS-only fix | `pnpm --filter @workspace/thinnr-mobile run release:update production --message "…"` (test with `preview` first) |
| Undo a bad OTA update | expo.dev → Updates → previous update → Republish |
| Register a new test iPhone | `eas device:create`, then a new preview build |
| Manage push / signing credentials | `eas credentials` |
| See which build a phone runs | iOS Settings → THINNR / Android App info (version and build number); expo.dev → Builds lists every build with its runtime fingerprint |

Icon provenance: the store icons under `assets/images/store/` are rendered
from the approved THINNR "T" mark (Playfair Display, cream on navy
`#203b64`); regenerate them from the same mark, never from a screenshot.
