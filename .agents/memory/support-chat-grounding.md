---
name: Provider AI Support chat grounding
description: Durable rules from building the office AI Support chat — grounding architecture, output guards, auth for internal data, history caps
---

# Provider AI Support chat — durable lessons

The office AI Support chat is the patient coach's sibling (same SSE plumbing
and reliability contracts, shared upstream knobs, separate limiter knobs) with
the opposite voice: comprehensive markdown + emojis. Details are in the code;
what follows is what the code cannot tell you.

## Marker-based broadening
When a two-stage retrieval needs the model to signal "these sources cannot
answer," make the signal a control marker stripped by the existing marker
filter and re-run the turn on the SAME open response stream with wider
sources. **Why:** one stream means no client re-request protocol, and the
model never sees an instruction it could quote at a user. Broaden only on
marker + zero visible text; marker + text means it answered.

## Brand invariants that must survive quoting
The knowledge documents themselves misspell the brand, so prompt rules can
never fully fix output that quotes sources verbatim. Enforce such invariants
as streaming rewrites chained into the response (like the dash smoother),
holding back only the smallest window needed across chunk boundaries.

## Internal data demands real auth — and no bundled credentials
A route that reads internal content with the service role must verify a real
session; per-IP limits and CORS are not authorization. Equally rejected: the
client auto-signing into a documented demo account — ANY credential shipped
in browser code is an authorization bypass, however "demo" it looks.
**How to apply:** open-demo personas get a sign-in-required card on live
internal-data features (the house lockout pattern); verify scripts mint
throwaway staff accounts with the service role instead of reusing documented
logins.

## Replayed-history caps
A comprehensive reply exceeded the request schema's per-message cap the
moment the client replayed it as history: turn one worked, turn two 400'd.
Size history caps from worst-case reply length (max completion tokens), not
from the composer's input limit, and have clients truncate replayed replies.
**How to apply:** e2e-test turn TWO of any new chat surface, not just turn one.
