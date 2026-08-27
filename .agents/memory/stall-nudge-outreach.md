---
name: Stall-nudge outreach decisions
description: Durable behavioral decisions for the coach stall nudge — ops eligibility framing, engagement/episode semantics, one-tap label detection.
---

# Stall-nudge outreach decisions

## Ops shows eligibility, never a delivery claim
The operations app computes the stall trigger from the same seeded series it displays, but delivery state (outreach seeded, engaged, opted out) lives in the patient's app. Ops copy therefore says the signals *crossed the threshold* on the crossing date and describes the app coach's designed response — it never asserts a conversation was sent or names a sent date.
**Why:** a code review rejected the sent-event framing as a false care event (patient may not have opened the app, may have opted out, may have engaged).
**How to apply:** any future staff surface for patient-app behavior must either read an authoritative propagated event or use eligibility language.

## Episode gate semantics
- An episode is keyed by the trigger's crossing date. **Any chat reply while the outreach is in the thread counts as engagement — including the decline chip.** After engaging, resuming check-ins re-arms future episodes only; nothing re-shows for the answered episode.
- The check-in screen's "Turn these off" pauses via opt-out **without** engaging, so Resume there restores the card for the same episode. The asymmetry is deliberate: stop-on-engagement is the stronger guardrail, and re-showing an answered episode reads as nagging.

## Send once, render the standing message
The send gate allows at most one send per episode (stamped crossing key) with a cooldown between episodes; a reopened session-only thread re-renders the already-sent unanswered message from persisted state rather than sending again.
**Why:** a code review rejected an unconditional same-episode re-seed as repeat nagging — proactive outreach must be provably once-per-episode even when chat history is ephemeral.

## One-tap accept labels
Sentence-shaped chip labels ("Yes, set me up") fail the server's whole-string affirmative set, so one-tap detectors must accept the exact label too — keep a byte-identical server copy of the label, pinned by the verify suite (same wire-contract rule as offer strings).
