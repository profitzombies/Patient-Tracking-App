---
name: Coach paced reveal
description: Where the typed-out reveal of coach replies lives and why; how to test paced streaming without breaking the stop/card contracts
---

# Coach paced reveal (typed-out replies)

The reveal engine lives in the coach chat context — not the UI layer, not the
SSE client. Deltas buffer in a hidden ref; an interval moves them into
`message.text` at a readable pace (tick/min-chars/catch-up constants exported
for tests). `message.text` is therefore ALWAYS exactly what the patient has
seen.

**Why:** stop() must keep exactly the visible text, and chips/cards must never
precede the text. With pacing in the context, stop/error/finalize read the
same revealed state the screen shows — no duplicated pacing in the UI, and the
SSE-client contract tests stay untouched.

**How to apply:**
- Card/quick-replies arriving mid-stream are HELD in reveal state and attach
  only at finalize — or at stop, for an already-arrived card ("card survives
  stop" behavior).
- The message stays `streaming` and the chat stays locked until the buffer
  drains, even after the network `done`.
- Catch-up chunk = max(minChars, ceil(pending/divisor)) so single-burst
  replies (recipe pipeline) finish in ~1–2.5s while still visibly typing;
  step is surrogate-pair safe.
- Testing under react-test-renderer uses REAL timers: every wait must be an
  act()-wrapped poll (small act-wrapped sleeps), and exact-text assertions on
  streaming bubbles become wait-until conditions. Prove new invariants with
  mutation runs (bypass the buffer → progressive-frames check fails; attach a
  card early → hold check fails).

**Verifying Stop in a live browser:** short replies finish before test automation can click Stop. Prompt for a long multi-paragraph answer (e.g. walk me through all program phases), wait until visible text appears in the bubble, then click Stop - the reading-pace reveal leaves a 10s+ window. Clicking during the silent thinking phase removes the empty bubble instead (valid, but a different contract).
