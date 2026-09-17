---
name: Coach data-driven product suggestions
description: Durable rules for coach product offers on real accounts — live-catalog-only grounding (offers AND prose sources), fail-closed loads, patient choice persistence, privacy export coverage, and the prompt wording the model needs.
---
Rule: product offers are computed server-side per turn (patient signals + per-product rules stored WITH the HQ catalog row) and handed to the model only through the marker allow-list. For real accounts EVERYTHING product-shaped comes from the office's LIVE offering: the offerable set (storefront ids, HQ copy/image, HQ topics) and the verbatim product grounding source alike. The bundled demo catalog is demo-persona-only. No office row = no offer and no product source; any live-load failure offers nothing and drops the demo source (chat still answers).

**Why:** the bundled catalog (demo prices, demo copy) leaked into real-account prompts twice: first as the offer identity source (HQ-created products un-offerable, HQ edits invisible), then as a keyword-selected grounding compartment that survived the offer fix because compartment selection happens before authentication. Both were review rejections. Demo prices on a real account misquote the patient; a silent fallback hides a broken billing read behind a friendly reply.

**How to apply:** any new prompt input that can name a product or price must branch on auth state, not on data presence, and route tests must use product-keyword messages (they select the demo compartment) and assert the demo copy/price markers are absent for success, closed-office, empty-office, and loader-failure paths.

## A patient's standing choice is written first, alone
"Stop suggesting products" (and resume) is persisted before EVERY other read of the turn, including the office lookup that precedes the reads, and the route derives this turn's paused state from the patient's words independently of the loader, so a loader failure still yields an acknowledging, offer-free prompt. Two review rejections came from "first" being true only after an earlier lookup, and from tests that injected the value the production path resolves itself; ordering tests must call the loader exactly as the route does.

## Bloodwork gating needs a persisted, staff-set marker
"Reviewed bloodwork" cannot mean "extraction completed" or "patient corrected a value"; the coach reads only the newest report a staff member explicitly marked reviewed (optional marker, staff-only route), within a freshness window. Extraction/edits are not clinical sign-off (the user rejected a mandatory confirmation step earlier), so the marker stays optional and only gates coach suggestions.

## New patient-owned columns join the privacy export
Every column added to a patient-owned table (opt-out flags, suggestion stamps, review markers) must be added to the export's explicit select lists; the export fake projects plain select lists like PostgREST so a forgotten column fails the export test.

## Health signals stay out of request logs
Signal ids and card reason ids name medication classes and lab findings. Log counts and the offer source kind only.

## The model under-recommends unless told when to say yes
The reasoning model treats every listed offer as optional and skips it on anything it classes as an "ordinary program question". State positively: when the message and a listed reason from their own data point at the same thing, answer the program question first, THEN mention the product; qualify the no-recommend carve-out. Prove with a live model check and run it twice.
