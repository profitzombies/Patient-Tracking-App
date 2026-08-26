---
name: Coach client-held conversation flows
description: Design decision — sub-conversations that bind a patient reply to held data run client-side, not through the model
---

**Rule:** When a coach exchange must bind the patient's next reply to held structured data deterministically (naming a just-scanned label, and similar confirm/rename steps), run it as a client-held flow: chat context state that answers the text locally with fixed coach-voice bubbles, instead of a model round trip.

**Why:** Model recall cannot be trusted to tie a later reply to earlier structured data, and a server-side flow would need session state. Client-held bubbles are ordinary finished messages, so the request history naturally tells the model what happened afterwards with no extra memory anywhere.

**How to apply:** Intercept at the single text-entry choke point so chips and typing behave identically. Decide explicitly which events abandon or survive the flow (a new photo supersedes it; stopping a reply keeps held data only if the patient saw the text). Accepted tradeoff: while a flow is active, plain text belongs to the flow — the exits are its own terminal actions. Testing gotcha: the request replays only a bounded recent window, and a multi-bubble flow can push the originating turn out of it, so history assertions should target recent bubbles.
