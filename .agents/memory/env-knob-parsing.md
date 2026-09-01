---
name: Env knob parsing
description: How numeric env knobs silently misparse and when knobs bake in at import time
---

- **`Number(process.env.X ?? "")` turns an UNSET knob into 0, not the default.** **Why:** `Number("")` is `0`, and `0` passes `isFinite && >= 0` guards — an unset resend-cooldown knob silently disabled the rate limit in production code while unit tests (which set the knob explicitly) stayed green. Only live e2e caught it. **How to apply:** treat null/blank as "unset" BEFORE calling `Number`; return the default for `null`, `""`, and whitespace. Regression-test the unset/blank/garbage/negative cases by deleting the env var inside the test.
- **Knobs read at module import time can't be changed per-test with plain env assignment.** **Why:** limiter sizes captured at import ignore values set in `beforeEach`. **How to apply:** in vitest, set import-time knobs inside `vi.hoisted()` so they exist before the module under test loads; knobs read per-call can be flipped inline (and restored in `finally`).
