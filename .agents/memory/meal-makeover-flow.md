---
name: Off-plan meal makeover flow
description: Chat-only approval verdicts on meal photo reads, citation-gated approval, and the chip-label wire contract shared by adjacency detectors and the correction guard.
---

# Off-plan meal makeover flow

## Approval is a citation check, never a retry
Each recognized meal item is approved only when the model cites a catalog id AND the item name reads as that catalog entry (server-side `verifiedApprovedCitation`). Uncited, unknown-id, and name-mismatch citations all silently count as **not approved** — no corrective retry, because a wrong verdict only changes chat wording, never card math.
**Why:** retrying vision reads for a soft judgment doubles cost and latency for zero card-payload benefit; the conservative default (off-plan) is the safe direction for a med-spa program.
**How to apply:** any future "have the model judge X against a catalog" feature should ride the same pattern: catalog in prompt, id citation out, server-side verification, bad citation = negative verdict.

## Verdicts are chat-only
`offPlanItems` lives beside the card payload in the analysis result and is formatted into reply text only — it must never ride any SSE payload, card, or persisted entry (diary stays judgment-free). Route tests assert the raw SSE body contains neither `approvedItemId` nor `offPlan`.

## Chip labels are a three-way wire contract
One-tap chip labels (yes/no set, meal_version set) are simultaneously: (1) the exact text the client sends, (2) the keys the server adjacency detectors match against replayed history, and (3) inputs the meal-correction detector must NOT read as corrections. Changing any label requires touching: quick-replies sets, the detector allow-lists, the polite-decline guard in BOTH meal-correction copies (server + mobile), and the phrase-parity table in the mobile verify suite.
**Why:** "No thanks" starts with "no" — without the polite-decline guard it reads as a meal correction and re-attaches the held photo to a decline.
**How to apply:** when adding a chip set near a card-bearing reply, add its labels to the correction parity table (expect false) and a decline-that-carries-a-fix case (expect true).

## Follow-up turns are text-only and cheap where possible
The makeover swaps turn is one non-streaming text call grounded by forcing the approved-foods compartment; the keep choice is fully canned (zero model calls); the approved version rides the existing recipe pipeline with `inspiration: "meal-makeover"` flipping on cravings-strength approved-only enforcement. The photo never re-rides follow-up requests — replayed history carries the plate description.
