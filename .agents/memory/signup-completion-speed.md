---
name: Signup completion speed & consent seed
description: How the post-password signup path stays fast (concurrent server steps, one-shot client seed straight to /consent) and the safety limits on that seed.
---

**Rule:** after GoTrue accepts the password, the independent signup steps (session mint, sign-in ledger, privacy snapshot, activation) run concurrently; every failure branch waits for ALL of them to settle before rolling back. The ledger stays fail-closed (502 + rollback + retryable code), not fire-and-forget.
**Why:** measured 2026-09-25: the serial chain was ~2 s server plus ~1.3 s of gate hydration (whoami, state+profile, privacy) before consent. After the change the server takes ~1 s, and a seeded signup is consent-ready ~1.1 s after the tap (it was ~3.4 s).
**How to apply:**
- A new signup skips the prior-history read on the ledger (a first sign-in can't be a new device).
- The response carries patientId + privacy; the mobile client sets a one-shot, 2-minute seed BEFORE verifyOtp (the account provider's effect can run before verifyOtp resolves). The first session that peeks owns it, a settled sign-out clears it, and the first hydration takes it.
- The seed only narrows access: it is used only when consent is unsatisfied, opens exactly like CONSENT_REQUIRED (writes blocked, flags null) and whoami still runs and overrides. Never seed onboarding or consent-satisfied state.
- Keep the busy/progress state through router.replace, or the button flashes back to "Create account" during navigation.
- Live timing harness: api-server scripts/signup-timing-live.ts N (creates and cleans throwaway accounts). The network is noisy, so compare medians and per-stage Server-Timing, not single runs.
- Suites that fake fetch with a bare object need `headers: new Headers()`: authedRequest reads response.headers (X-Billing-Scope), and a missing header object shows up as "unresolved account".
