---
name: Coach reply shape
description: Contract for spaced multi-block coach replies and the prompt phrasing that actually produces them.
---

Coach replies are a two-sided contract: the server prompt asks for 2–4 short thought blocks separated by blank lines ending in a follow-up question, and the mobile chat bubble splits assistant text on blank lines into separately spaced paragraphs (streaming-safe: whitespace-only trailing fragments are skipped). Any new coach reply path (recipe/JSON turns included) must keep emitting blank-line blocks or replies collapse back into one dense paragraph.

**Why:** With "when it fits naturally, close with a follow-up question" phrasing, the model skipped the closer in every live test. Rephrasing it as the default ("End with a short closing block... Even a simple yes-or-no answer gets two blocks", skip only when repetitive/wrapping up) made it appear reliably, including on refusals, without harming grounding.

**How to apply:** When adding optional coach reply behaviors, phrase them default-on with explicit skip conditions, and verify with a few real model calls — mocked tests cannot catch the model ignoring soft "optional" instructions. JSON-pipeline replies need the blank line written as \n\n inside the JSON string (escaped as \\n\\n in TS template literals).
