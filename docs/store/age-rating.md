# Age rating answers

Answer exactly as below; the rating follows from the answers. Both
questionnaires are re-asked when a new build changes capabilities, so revisit
this file when Tap to Pay or any new content type ships.

## Apple — Age Rating questionnaire (App Store Connect → App Information)

| Question | Answer | Why |
| --- | --- | --- |
| Cartoon or Fantasy Violence | None | |
| Realistic Violence | None | |
| Prolonged Graphic or Sadistic Realistic Violence | None | |
| Profanity or Crude Humor | None | Coach output is filtered to program topics |
| Mature/Suggestive Themes | None | |
| Horror/Fear Themes | None | |
| **Medical/Treatment Information** | **Frequent/Intense** | Medication schedules and reminders, lab-report values, weight-loss program guidance, clinician messaging |
| Alcohol, Tobacco, or Drug Use or References | None | Prescription medication reminders are medical, not drug-use content |
| Simulated Gambling | None | |
| Sexual Content or Nudity | None | Progress photos are the patient's own, never shared publicly, and the guide asks for fitted clothing |
| Graphic Sexual Content and Nudity | None | |
| Contests | None | The office leaderboard awards no prizes from Apple's perspective; it is clinic-internal recognition |
| Unrestricted Web Access | No | The app opens no general browser |
| Gambling | No | |
| **Made for Kids** | No | |
| Age verification / parental gate | Not applicable | Accounts exist only through a clinic invitation to an adult patient |

Resulting rating: **17+** (driven by Medical/Treatment Information). Do not
try to lower it by answering "Infrequent/Mild" — medication reminders and
lab values are frequent, and a mismatch is a rejection reason.

## Google Play — Content rating (IARC) questionnaire

Category: **Utility, Productivity, Communication, or Other** (there is no
"Medical" category; health apps use this one).

| Question | Answer |
| --- | --- |
| Does the app contain violence, blood or gore? | No |
| Sexuality or nudity? | No |
| Potentially offensive language? | No |
| Controlled substance references (drugs, alcohol, tobacco)? | No — prescription medication reminders are not depictions of drug use |
| Simulated or real gambling? | No |
| Crude humor? | No |
| Does the app share the user's current location with other users? | No |
| Does the app allow users to interact or exchange content (messaging)? | **Yes** — patient ↔ clinic staff messaging only, no patient-to-patient contact |
| Does the app share personal information with third parties? | No (service providers only — see Data safety) |
| Does the app allow purchase of digital goods? | No (physical goods only, via Stripe) |
| Does the app contain user-generated content visible to others? | Yes, only to the patient's own clinic staff (photos, messages); not public |

Expected result: **Everyone** (ESRB) / **PEGI 3** / equivalents, with the
"Users interact" and "Shares info" interactive elements as answered.

## Play — Target audience and content

- Target age group: **18 and over** only. Do not tick any under-18 group;
  that would trigger the Families policy.
- "Could the app unintentionally appeal to children?" → No.
- Store listing contains no content aimed at children.

## Play — Health apps declaration (Policy → App content → Health apps)

Tick:
- **Health and fitness** → activity and fitness tracking, diet and nutrition,
  weight management.
- **Medical** → medication management, patient–provider communication,
  medical records (lab reports).
- The app **reads Health Connect** data types weight and steps (declaration
  text in [health-justification.md](health-justification.md)).
- The app is **not** a medical device and makes no diagnostic claims (the
  disclaimer in [medical-disclaimer.md](medical-disclaimer.md) is in the
  description and the in-app consent).
