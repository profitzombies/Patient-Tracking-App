# HealthKit and Health Connect justification

Both platforms ask why a health-data permission is needed and reject apps
whose stated use does not match what the permission does. THINNR **reads two
types — body weight and step count — and writes nothing.** The permission is
requested only when the patient taps *Connect health data* on the Account
screen, never at launch.

## Apple — HealthKit (paste into App Review notes under "HealthKit")

> THINNR reads HealthKit body mass and step count samples, and only after
> the patient taps "Connect health data" (Account → Device features). The
> weights are added to the patient's progress chart and are visible to the
> patient's own clinic, which supervises their weight-loss program; steps are
> shown alongside daily check-ins. THINNR never writes to HealthKit
> (NSHealthUpdateUsageDescription states this), never requests clinical
> records, and does not use HealthKit data for advertising, marketing or any
> purpose other than the patient's program. HealthKit data is stored only in
> the patient's own record and is covered by the in-app deletion and export
> controls. The app functions fully without the permission.

Info.plist strings already in the build (`app.json`):

- `NSHealthShareUsageDescription`: "THINNR reads only the weight and step
  measurements you approve for your patient account."
- `NSHealthUpdateUsageDescription`: "THINNR does not write health data."

Checklist (Guideline 5.1.3 Health and Health Research):
- [x] Not used for advertising or data mining.
- [x] Not disclosed to third parties other than the patient's own clinic
  and infrastructure processors.
- [x] No write access; no false or misleading health claims (see
  [medical-disclaimer.md](medical-disclaimer.md)).
- [x] Privacy policy URL describes health data handling: `https://app.trythinnr.com/privacy`
  names Apple Health / Health Connect, and `https://app.trythinnr.com/health-data`
  is the dedicated Health data notice (link it in the review note too).

## Google — Health Connect declaration (Play Console → App content → Health Connect)

Data types requested: `android.permission.health.READ_WEIGHT`,
`android.permission.health.READ_STEPS`. No write permissions. No background
read permission.

Declaration text (≤ 500 characters per field; split as the form asks):

**Why does your app need Health Connect?**
> THINNR is a companion app for a clinic-supervised weight-loss program.
> With the patient's permission it reads body weight and daily step count
> from Health Connect so weights from a connected scale and daily steps
> appear in the patient's progress history, which the patient's own clinic
> uses to supervise their care. The app does not write to Health Connect.

**How is the data used?**
> Weight and step values are stored in the patient's clinical record in
> THINNR, shown to the patient on their Progress screen and to the staff of
> the clinic that enrolled them. They are not used for advertising, not sold,
> not shared with other users, and can be deleted by closing the account
> from the app.

**Core functionality**: Fitness and wellness → weight management; Clinical /
medical care → patient monitoring.

Health Connect privacy-policy requirement: the privacy policy URL on the
listing (`https://app.trythinnr.com/privacy`) names Health Connect and the
Health data notice (`/health-data`) lists weight and steps with the uses above. The in-app "privacy policy" dialog that
Health Connect opens (`androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`)
is provided by `react-native-health-connect` and must point at the
Health data notice URL — confirm it opens (device-verification item H-3).

## Rejection traps

- Asking for the permission at first launch (we do not; it is behind a
  button).
- Requesting types that the UI never shows (we show both).
- A privacy policy that does not mention health data (ours does; keep the
  Health data notice in step with the permissions).
- Describing the app as diagnosing or treating (see disclaimer).
