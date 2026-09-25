---
name: Patient invitation app link
description: Why patient invite emails use PATIENT_INVITE_URL (Expo Go page) separate from PATIENT_APP_URL, and how the invite flow really works for patients.
---

- Invite emails link `PATIENT_INVITE_URL` (production-only env value = published site + `/thinnr-mobile/`, the Expo Go page), falling back to PATIENT_APP_URL, then (dev only) the Expo dev domain. On the published site, dev-preview or non-https links are refused and the invite is recorded as not configured.
  **Why:** PATIENT_APP_URL also builds web deep links (`/billing`, `/security-report`) that 404 on the Expo Go page, so the two can't share one value.
  **How to apply:** new patient-app links for native/Expo use the invite resolver. Web deep links stay on PATIENT_APP_URL.
- The real invited-patient path is Welcome → **Create New Account → I have an invitation** → invited phone/email → code → password. The "Claim account" route is staff-only. Invited signup asks for no DOB. Copy must never tell patients to tap Log In or say they have no password.
- Live proof: the patient-invite live script uses Resend `delivered+…@resend.dev` and reads the sent email back through the Resend API. Against the dev workspace it fails the link check by design, because dev links its preview. For local proof, run a built api-server with NODE_ENV=production and PATIENT_INVITE_URL on a spare PORT.
- Route suites that call office routes must fake the practice setup gate: a `setup_override_at` on the launch row, plus a `practice_launch_completions` handler.
