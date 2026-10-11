# App Privacy (Apple) and Data safety (Google) answers

Derived from what the shipped app actually sends to the THINNR API and which
SDKs it bundles — not from what the product could do. Re-audit when a route
or native module is added. The audit basis is at the end.

## Summary that both forms need

- **Collects data:** yes. **Linked to the user:** yes, everything (there are
  no anonymous users; every record belongs to a patient or staff account).
- **Used for tracking (Apple definition — across apps/sites for ads or data
  brokers):** **No.** There is no advertising SDK, no attribution SDK, no
  third-party analytics and no crash reporter. Apple's "Tracking" section is
  answered *No*; no App Tracking Transparency prompt exists.
- **Encryption in transit:** yes (TLS everywhere). **At rest:** yes
  (managed Postgres and object storage).
- **Deletion:** the user can request deletion in the app
  (Account → Privacy & data → Close my account) and request an export
  (Request my data). Play: "Users can request that data be deleted" → Yes,
  and provide the deletion URL (`https://app.trythinnr.com/delete-account`, the public delete-account
  page, which also lets a patient request closure with an emailed code).
- **Third parties receiving data (processors, not "sharing" in Play's
  sense):** Supabase (database/auth/storage), Stripe (payments, card data
  never touches THINNR), Twilio (SMS codes), Resend (email), OpenAI via a
  Replit-managed proxy (coach and support chat text, meal/label/menu photos
  and lab-report images sent for extraction), Expo push service and
  Apple/Google push (device tokens), WarehouseCraft (name + shipping address
  for physical orders), Open Food Facts / FatSecret / USDA (barcode and food
  search terms only — no identity). None of these is "sharing" under Play's
  definition because each acts as a service provider under contract; Apple's
  form has no sharing question, only purpose.

## Apple — App Privacy (one row per data type)

Purposes used below: **App Functionality** (AF), **Analytics** (AN —
first-party only), **Product Personalization** (PP). Nothing is used for
*Third-Party Advertising*, *Developer's Advertising or Marketing*, or
*Other*. Every row is **Linked to You: Yes** and **Used to Track You: No**.

| Category | Data type | Collected | Purposes | Source in app |
| --- | --- | --- | --- | --- |
| Contact Info | Name | Yes | AF | Invitation, profile |
| Contact Info | Email Address | Yes | AF | Sign-in, receipts, invitations |
| Contact Info | Phone Number | Yes | AF | Sign-in codes, staff second factor |
| Contact Info | Physical Address | Yes | AF | Shipping address at checkout only |
| Health & Fitness | Health | Yes | AF, PP | Weight, height, measurements, check-ins, side effects, medications and doses, lab-report values, HealthKit weight + steps (after opt-in) |
| Health & Fitness | Fitness | Yes | AF | Steps from HealthKit (after opt-in) |
| Financial Info | Purchase History | Yes | AF | Orders and subscriptions with the clinic |
| Financial Info | Payment Info | **No** | — | Card details are entered in Stripe's SDK and go to Stripe directly; THINNR stores only Stripe's customer/payment ids |
| User Content | Photos or Videos | Yes | AF, PP | Meal, label, menu, progress photos, lab-report images |
| User Content | Other User Content | Yes | AF | Food diary, coach chat, care-team messages, notes |
| User Content | Audio Data | No | — | Microphone is not requested |
| Identifiers | User ID | Yes | AF, AN | Account id |
| Identifiers | Device ID | **No** | — | Push tokens are stored but are not IDFV/IDFA; Apple classifies push tokens under "Other Diagnostic Data"/none — answer No |
| Usage Data | Product Interaction | Yes | AN, PP | First-party app events (screens opened, features used) tied to the patient record |
| Diagnostics | Crash Data | No | — | No crash reporter |
| Diagnostics | Performance Data | No | — | |
| Diagnostics | Other Diagnostic Data | Yes | AF | Sign-in ledger keeps user agent and IP address for the security page ("Sign out everywhere else", "This wasn't me") |
| Location | Precise / Coarse | **No** | — | Not requested in this build (Tap to Pay, when enabled later, asks for location on the staff side only — update this row then) |
| Sensitive Info | Sensitive Info | No | — | No racial, sexual-orientation, religious or biometric *data* is collected; Face ID is used only through the OS and never leaves the device |
| Contacts, Browsing History, Search History (outside app), Surroundings | — | No | — | Food search terms stay inside the app's own search feature (counted under Product Interaction) |

Also tick in the "Data collection practices" step: data **is not** collected
from users under 13 (there are none); the app **does** allow users to
request deletion.

## Google Play — Data safety

**Overview answers**

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes |
| Do you provide a way for users to request that their data is deleted? | Yes |
| Independent security review | No |
| Account creation | Yes — "Username and password" (patients also set a password), plus "Other" (one-time code) |
| Account deletion URL | `https://app.trythinnr.com/delete-account` |

**Data types** — for every row: *Collected* = Yes, *Shared* = No, *Processed
ephemerally* = No, *Required or optional* as listed, purposes = **App
functionality** plus **Analytics** where marked, plus **Personalization**
where marked. (Google counts service providers as "collection", not
"sharing"; that is why every Shared column is No.)

| Category | Type | Required? | Purposes | Notes |
| --- | --- | --- | --- | --- |
| Personal info | Name | Required | App functionality | |
| Personal info | Email address | Required | App functionality, Account management | |
| Personal info | Phone number | Optional | App functionality, Account management | Staff second factor; patient alternative sign-in |
| Personal info | Address | Optional | App functionality | Checkout shipping address |
| Personal info | User IDs | Required | App functionality, Analytics | Account id |
| Financial info | Purchase history | Optional | App functionality | Orders, subscriptions |
| Financial info | Payment info | — | — | **Not collected** (Stripe SDK) — do not tick |
| Health and fitness | Health info | Required | App functionality, Personalization | Weight, measurements, medications, side effects, lab values, Health Connect weight |
| Health and fitness | Fitness info | Optional | App functionality | Health Connect steps |
| Photos and videos | Photos | Optional | App functionality, Personalization | Meal/label/menu/progress/lab photos |
| Messages | Other in-app messages | Required | App functionality | Care-team chat, coach chat |
| App activity | App interactions | Required | Analytics, Personalization | First-party usage events |
| App activity | Other user-generated content | Required | App functionality | Food diary, notes, custom foods |
| App info and performance | Diagnostics | Required | App functionality | Sign-in ledger: user agent, IP (security page) |
| Device or other IDs | Device or other IDs | — | — | **Not collected** — push tokens are credentials for delivery, Google does not count FCM tokens as device IDs; answer No |
| Location | Approximate / precise | — | — | **Not collected** in this build; flip to *Precise, optional, App functionality* when `TAP_TO_PAY_ENABLED=1` ships |
| Audio, Files and docs, Calendar, Contacts, Web browsing, Search history, Installed apps | — | — | — | Not collected. (Lab-report PDFs are uploaded by the user but Google's "Files and docs" means general file access; declare them under *Health info* as done above) |

**Data handling disclosures** (free text, if asked): "All data is collected
to deliver the patient's clinic weight-loss program and is visible only to
the patient and their own clinic's staff. Data is processed by contracted
service providers (hosting, payments, SMS/email delivery, AI model inference)
and is never sold, used for advertising, or shared with other users."

## Health Connect — Play Console declaration (Data safety → Health Connect)

Declared read types: **Weight**, **Steps**. Write types: none. Use the
justification text in [health-justification.md](health-justification.md).
Reason categories: **Fitness and wellness** and **Clinical / medical care**
("the data is shown to the patient's healthcare provider"). Not *Health
research*.

## Audit basis (what the app ships — re-check these when answering again)

- Routes the mobile app writes to (grep `authedRequest('POST'` in
  `artifacts/thinnr-mobile/lib/patient-data-api.ts`): entries, check-ins,
  health-measurements (weight_lb, steps), library, medication-doses, photos,
  presence, profile setup/contact verify, export, deletion, coach
  conversations, media cleanup; plus push token registration
  (`lib/push-notifications-api.ts`), app events, care-team chat, bloodwork
  uploads, shop checkout (Stripe).
- Native modules (`app.json` plugins and `package.json`): expo-camera,
  expo-image-picker, expo-media-library, expo-sensors, expo-av (playback
  only, `microphonePermission: false`), expo-notifications,
  expo-local-authentication, expo-secure-store, react-native-health
  (read weight + steps), react-native-health-connect (READ_WEIGHT,
  READ_STEPS), @stripe/stripe-react-native. Stripe Terminal only with
  `TAP_TO_PAY_ENABLED=1` (`app.config.js` strips NFC/location otherwise).
- Server stores IP + user agent per sign-in (`auth_sign_ins`), used only
  on the security page; retention follows the organization policy.
- No analytics/ads/crash SDKs: grep `package.json` for `sentry`,
  `firebase`, `amplitude`, `segment`, `mixpanel`, `facebook`, `adjust`,
  `appsflyer` → none.
