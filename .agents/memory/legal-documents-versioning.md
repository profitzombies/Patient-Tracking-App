---
name: Legal documents versioning
description: How the public privacy/terms/health-data documents, the patient consent version, and the in-app reader stay in lockstep.
---

# One version drives everything

The Privacy Policy, Terms of Use and Health data notice live as markdown in the shared
`@workspace/legal-documents` lib with ONE `version.json` (version + effective date +
draft/final status). The patient consent policy version is derived from that version
(a lockstep test asserts equality), so bumping the document version re-prompts every
patient for consent. Do not bump the version for wording-only draft edits unless a
re-prompt is intended; the owner flips `status` to `final` when counsel signs off and
the draft banner disappears everywhere with no code change.

**Why:** store listings, the web pages, the API bundle and the app's bundled offline copy
must never disagree about which text a patient agreed to.

**How to apply:**
- Edit markdown → run the lib build (the generated TS is checked by `--check` in validation).
- Web document pages render the bundled lib copy directly (no fetch); only support and
  delete-account pages call the API.

# Consent integrity rule (mobile)

A patient may only agree to a policy version whose text they can read. The reader picks the
copy carrying EXACTLY `consent.requiredVersion` (bundled first, then the API bundle); any
other copy stays readable offline but is labeled outdated, and the consent screen keeps
"Agree" disabled until a current copy loads (with a retry). "Server newer than bundled"
is NOT the rule when a required version is known — a newer server text is not what the
patient is being asked to agree to either.

**Why:** an older app after a text bump would otherwise record agreement to wording the
patient never saw; a reviewer rejected the first "prefer newer" version for this reason.

# Public account deletion

`/delete-account` uses a separate code purpose (`account_deletion`) on the existing
passwordless send path and caps; start is always neutral (200 with a requestId even for
unknown identities), verify answers 200 `alreadyPending` with the grace end or 202 `filed`.
Texted deletion codes ride a dedicated Twilio Verify service — see twilio-verify-per-purpose.md.
