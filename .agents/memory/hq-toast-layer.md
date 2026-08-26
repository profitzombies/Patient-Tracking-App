---
name: HQ toast notification layer
description: Durable rules for the operations app's toast/sound/progress system and how to verify it
---

- Radix Toast announces to screen readers only when a toast OPENS; a toast that changes in place (progress → done/failed) needs a separate persistent polite live region fed by the store, or the end state is silent.
- Sound is decided centrally by variant inside the toast layer (success ding / destructive tone, synthesized — no audio assets), never by callers; the on/off preference persists per browser and defaults on.
- Progress toasts must be exempt from the visible-stack eviction cap, and end-state transitions must be idempotent (double done()/fail() = one sound, one announcement).
- Writes behind a gate (guided demo, auth) return a landed boolean; the gatekeeper toasts the failure itself and callers toast success strictly on true — prevents false "saved!" toasts.
- Verification split: browser e2e can't hear audio and can't spam the stack cap (Save buttons disable once a form is clean), so cap/eviction/sound live in the hermetic suite; keep that suite's real-time waits test-sized via a timing override — multi-second sleeps proved abort-prone under parallel validation load.

**Why:** double-speak and silent morphs are the classic toast a11y failures, and demo-gated writes previously invited success toasts for writes that never landed.
**How to apply:** pick the variant and let sound/duration follow; route any in-place toast update through the announcer; branch success toasts on the landed boolean; never add long real sleeps to verify suites.
