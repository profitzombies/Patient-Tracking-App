---
name: Coach diet grounding and food-list guard
description: How the AI coach honours a patient's diet, lists and diet changes — grounding block, reply-side guard, free-text tagger rules, confirm-to-add chips, honest phase-2 limits.
---

# Coach diet grounding and food-list guard

**Rule:** diet awareness branches on the real-account diet state being present
(signed-in accounts only); the demo persona never gets a diet block, so demo
prompts stay byte-identical. The block renders inside the patient compartment
after the "Today so far" line so the patient section stays one cache prefix.

**Streamed text cannot be retracted.** The guard is deterministic only on
structured outputs: menu-scan picks (moved to avoid with reason / dislikes
dropped), recipe drafts (classifier problems re-enter the bad-citation retry
loop), plate/label fit lines, and quick-reply chips (one listed food drops the
WHOLE chip set → client falls back to yes/no). Free-text replies rely on the
prompt's list rules; a slip-rate harness for streamed prose is a follow-up.

**Tagger is conservative, per component.** No tag → `unknown`, never `fits`.
A dish is split into components (punctuation, "with/and/on/over/in/topped/
served…") and a free-from qualifier ("dairy-free", "vegan", "gluten-free")
only strips tags inside ITS component; tags are the union across components.
**Why:** a whole-dish qualifier let "cheddar cheese with dairy-free bread"
pass a milk allergy (code-review catch). The direction of error must always
be "flag a safe food", never "pass an allergen". Compound rewrites ("almond
milk", "turkey bacon") must map to words that have tagger entries, or the tag
is silently lost. Label numbers alone can say `does_not_fit`, but a label fit
line never says "yes" (ingredients unseen).

**Confirm-to-add:** server authors the verbatim offer line and the chips; the
next turn is recognised only by strict adjacency (offer line ends the previous
assistant message, user reply is a known tap). Allergies ask Mild/Severe first.
That turn makes zero model calls and writes with the coach as entered-by.
Already-listed foods are never re-offered (label containment OR the phrase
resolving to a catalog key already on that list).

**Spoken labels must land on catalog keys:** the classifier matches allergy and
sensitivity items by catalog key against inferred tags / ingredient terms; a
custom item only matches its literal label. Saving "tree nuts" or "peanuts" as
a custom key silently fails to block almonds or peanut butter. The foundation
parser therefore resolves free-text allergy/sensitivity labels (plurals,
"dairy", member foods like shrimp/almonds → their group) to catalog keys when
no key is supplied; only unknown foods stay custom, dislikes always do. Any
new write path must go through that parser, and tests must classify a food
AFTER the write rather than asserting the write and the guard separately.

**Diet-change ack:** a nullable acknowledgement stamp on the selection row; the
first reply is prefixed once and the row is stamped fire-and-forget after the
stream closes. "Just tracking" picked first is never acknowledged; it is when
it replaces a real diet. Whole30 counts the start date as day 1.

**Deploy order:** real-account grounding reads the acknowledgement column on
every chat turn, so the migration must reach production BEFORE the API ships
or authenticated chat 500s. The migration runner's `--project` flag applies
only what its checksum ledger lacks and verifies postconditions.

**Why:** owner decisions — rule sheet is the authority, suggestions never hit
lists, additions only on confirmation, one brief ack, phase-2 areas (FODMAP,
histamine, oxalate, purine) said plainly rather than guessed.

**How to apply:** new coach surfaces that produce food names must run them
through the shared guard with the grounding's classifier context; real-account
coach route suites must fake the diet tables (a missing table is a deliberate
502, not a silent "no diet").
