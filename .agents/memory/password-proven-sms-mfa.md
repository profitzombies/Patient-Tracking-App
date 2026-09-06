---
name: Password-proven SMS MFA
description: Security and latency contract for patient password login before SMS verification.
---

After a patient password is proven and the MFA request is durably registered, the app may open the verification screen before Twilio accepts or delivers the SMS. Unknown accounts and wrong passwords must still keep neutral response timing.

**Why:** Waiting for Twilio plus its provider-sized timing floor made valid sign-in feel stalled. A valid password already proves knowledge of that account, so its success path can be fast without revealing account existence to an unauthenticated guesser.

**How to apply:** Keep the post-password patient/contact/auth-link re-check before registration, start SMS delivery after responding, consume rejected sends asynchronously, and keep invalid-credential responses on the neutral timing path.