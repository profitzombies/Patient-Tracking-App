# Listing copy

Field limits are Apple's and Google's current ones; counts are given so the
text can be pasted without trimming. Both stores get the same message; only
the fields differ.

## Identity

| Field | Value |
| --- | --- |
| App name (both) | `THINNR` |
| Subtitle (Apple, ≤30) | `Your clinic's weight-loss app` (29) |
| Short description (Play, ≤80) | `Food diary, coach and progress tracking for your clinic's weight-loss program.` (79) |
| Bundle id / package | `com.thinnr.app` |
| Primary category (Apple) | Medical |
| Secondary category (Apple) | Health & Fitness |
| Category (Play) | Medical |
| Tags (Play) | Weight loss, Nutrition, Health tracker |
| Price | Free (the app is provided by the patient's clinic; in-app purchases are physical goods sold by the clinic through Stripe, not In-App Purchase) |
| Support URL | `https://app.trythinnr.com/support` |
| Marketing URL | `https://app.trythinnr.com` |
| Privacy policy URL | `https://app.trythinnr.com/privacy` (both consoles fetch it) |
| Terms URL (Apple EULA field) | `https://app.trythinnr.com/terms` |
| Copyright | `© 2026 THINNR` |
| Contact email (Play "App support", Apple contact) | `support@trythinnr.com` — the address on the public support, privacy and terms pages. (The in-app support assistant still quotes `Support@Thinnrweightloss.com`; make sure both mailboxes are read, or align the assistant.) |

The public pages are served by the operations site (`/privacy`, `/terms`,
`/health-data`, `/support`, `/delete-account`); open each URL in a private
window before submitting — the consoles fetch them.

## Promotional text (Apple, ≤170, editable without a new build)

> THINNR is used with a clinic's supervised weight-loss program. Ask your
> provider for an invitation to get started.

## Description (Apple ≤4000, Play ≤4000)

THINNR is the companion app for clinics that run a medically supervised
weight-loss program. Your clinic invites you; the app then keeps you on
plan between visits and keeps your care team in the loop.

**Log food in seconds**
Search a food database built around the program's approved foods, scan a
barcode or a nutrition label, or snap a photo of your plate and let the
coach describe and log it for you. Every entry shows calories and macros
against your daily targets, and the diary tells you when a food fits your
current phase.

**A coach that knows your plan**
Ask the THINNR coach what to order at a restaurant, how to swap an
ingredient, or for a recipe from what is in your fridge. Answers follow
your clinic's program and your current phase. The coach does not give
medical advice; medical questions go to your care team.

**Message your care team**
Send a message to your clinic's staff and get a reply in the app. Your care
team can see your diary, weights and check-ins so visits start from what
actually happened.

**Track what matters**
Daily check-ins, water, weekly guided progress photos that line up the same
way every week, body measurements and a weight chart. Optionally connect
Apple Health or Health Connect so weights from your scale and daily steps
flow in automatically — THINNR only reads weight and steps, and never
writes to your health data.

**Stay on schedule**
Add your medications and get reminders at the times you choose. Upload a
lab report and your care team sees the results.

**Order from your clinic**
Buy the program products your clinic offers, track orders and manage
subscriptions, all inside the app.

**Private by design**
Your account is created only through a clinic invitation. You can download
everything THINNR holds about you or close your account from the app at any
time. THINNR contains no ads and no third-party tracking.

THINNR is a tool for a program supervised by your own healthcare provider.
It does not diagnose, treat or prescribe, and it is not a substitute for
medical advice. Always follow your provider's instructions and contact them
with medical questions. If you think you are having a medical emergency,
call your local emergency number.

**For clinic staff**
Sign in with your work email to see your patient roster, respond to
messages, record visit weights and measurements, take payments and complete
staff training — from the same app.

## Keywords (Apple, ≤100 characters, comma-separated, no spaces)

```
weight loss,food diary,calorie,macro,med spa,clinic,nutrition,coach,meal log,check-in,progress photo
```
(99 characters.)

## What's new (both, first release)

> First release of THINNR for patients and clinic staff: food diary with
> barcode, label and photo logging, the program coach, care-team messaging,
> check-ins, guided progress photos, medication reminders, Apple Health /
> Health Connect weight and step import, and clinic orders.

## Age rating line (shown on the listing)

Apple: **17+** (Medical/Treatment Information: Frequent/Intense; see
[age-rating.md](age-rating.md)). Play: IARC rating from the questionnaire,
expected **Everyone** / **PEGI 3**, with the Play "Health apps" declaration
completed.

## Play Console extra fields

- **App access:** "All or some functionality is restricted" → paste
  [reviewer-notes.md](reviewer-notes.md).
- **Ads:** No, the app contains no ads.
- **Target audience:** 18 and over.
- **News app:** No. **COVID-19 contact tracing / status:** No.
- **Health apps declaration:** Yes — "Health and fitness" and "Medical"
  features; the app reads Health Connect data (see
  [health-justification.md](health-justification.md)).
- **Financial features:** No (payments are for physical goods via Stripe;
  the app is not a banking, loan or crypto product).
- **Government apps:** No.
