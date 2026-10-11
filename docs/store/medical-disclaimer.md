# Medical disclaimer

One wording, used in three places. Keep them identical so a reviewer who
compares the listing with the app finds the same statement.

## Short form (listing descriptions — already included in listing-copy.md)

> THINNR is a tool for a program supervised by your own healthcare provider.
> It does not diagnose, treat or prescribe, and it is not a substitute for
> medical advice. Always follow your provider's instructions and contact them
> with medical questions. If you think you are having a medical emergency,
> call your local emergency number.

## Long form (in-app consent screen and public terms)

> **THINNR is not a medical device and does not provide medical advice.**
> THINNR supports a weight-loss program that is prescribed and supervised by
> your own healthcare provider. The food diary, the coach, reminders,
> progress tracking, lab-report display and any targets shown in the app are
> informational tools for that program. They do not diagnose, treat, cure or
> prevent any condition, do not replace the judgment of your provider, and
> do not change any medication or dose. The coach is an automated assistant
> that answers questions about food and the program only; it is not a
> clinician and may be wrong. Medication reminders depend on your device
> settings and may be delayed or missed; do not rely on them as the only
> prompt for a dose. Lab values are shown as received from your report and
> are reviewed by your care team, not interpreted by the app. Always follow
> your provider's instructions, tell them about side effects or changes in
> how you feel, and contact them with any medical question. If you think
> you are having a medical emergency, call your local emergency number
> immediately.

## Where it lives

| Place | Status |
| --- | --- |
| App Store and Play descriptions | In [listing-copy.md](listing-copy.md) (short form) |
| In-app consent (`artifacts/thinnr-mobile/app/consent.tsx`) and in-app legal reader | The consent step links to the Terms of Use, whose §2 "Not medical advice" carries the statement; the long form above is the fuller wording to add to the consent step itself (follow-up task) |
| Public terms page (`https://app.trythinnr.com/terms`, `lib/legal-documents/documents/terms-of-use.md` §2) | Live; shorter wording with the same meaning. When the terms are next versioned, use the long form so all copies match |
| Play "Health apps" declaration free text | Short form |
| Coach system prompt | Already refuses dosing/medical questions and refers to the care team (`artifacts/api-server/src/coach/prompt.ts`); no change |

## What not to say anywhere on the listing or screenshots

- "Lose X pounds", "guaranteed", "clinically proven", "FDA" (any form).
- Names of prescription medications in screenshots or copy (the medications
  screenshot uses a generic sample name — see [screenshots.md](screenshots.md)).
- Before/after body photos.
- Anything implying the app itself provides treatment, diagnosis or
  dosing. Apple Guideline 1.4.1 and Play's Health misinformation and
  Medical functionalities policies are both enforced against listing copy.
