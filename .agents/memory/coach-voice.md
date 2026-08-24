---
name: Coach voice contract
description: Keeping the coach's warm texting voice consistent across pipelines without breaking grounding, markers, or chips
---

- One persona + voice block (shared exported constants in the api-server coach prompt module) feeds BOTH the plain streaming chat and the structured recipe/cravings prompts; menu-scan mirrors the tone in its message-field guidance. Editing voice in one pipeline reintroduces personality switches.
- **Stock-opener regression:** told merely to "acknowledge first", the model settles on one canned opener ("Good question.") for most replies. What held in live runs: ban the generic openers by name AND add "never open the same way twice in a row".
- Fixed strings that speak for the coach (canned declines, seeded greeting) must be written in the same voice, shaped as blank-line blocks, and must NOT end with "?" — the client shows fallback yes/no chips under any finished reply that ends with one.
- The greeting is seeded client-side in the coach chat context: a normal `done` assistant message with a fixed id outside the generator's id space and no `replyToId` (quick-reply chips gate on `replyToId`). It rides request history, so the model knows it already greeted and never re-greets (verified live). Transcript-pinning suites filter it out by id instead of rewriting every expected string.

**Why:** voice edits are prompt-only, but marker emission (`[[replies:]]`, `[[product:]]`), verbatim rule quoting, and closer presence all drift under prompt changes; mocked tests cannot catch the model ignoring style instructions.

**How to apply:** any voice touch → edit the shared constants (not one pipeline), re-run the coach-stop suite, then live-probe real SSE turns (plain, exact-wording rule, refusal, recipe, craving, product topic, stopped follow-up, menu photo) and check tone + blocks + closer + markers + verbatim quotes in the same pass.
