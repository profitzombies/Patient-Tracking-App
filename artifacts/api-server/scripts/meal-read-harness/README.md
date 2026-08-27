# Meal-read side-by-side harness

The gate for any knob that could touch meal-plate read quality (reasoning
effort, prompt trims, token caps). It runs the **production** plate-read code
path over every fixture plate at each requested setting and records a
side-by-side report against the shipped default.

## The rule

> No latency knob that can affect read quality ships unless it reaches
> **parity with the default read across the entire fixture set** in a
> recorded run committed to `results/`. One clean probe plate is never
> evidence.

This rule exists because a 2026-08 speed-up shipped `reasoning_effort:
"none"` for the plate read after a single clean probe photo, and real-world
reads degraded (see `results/` for the recorded divergence). The default
(knob omitted) is the accuracy bar; candidates must prove they match it,
not merely look plausible once.

## Fixtures

`fixtures/*.jpg` — deliberately awkward plates: glossy sauces that hide
food, deep bowls that obscure amounts, gravy over sliced meat, crowded
breakfast plates, topping-buried chili. Add plates that trip reads; never
trim the set down to easy ones.

## Running (live model calls — costs tokens)

```sh
pnpm --filter @workspace/api-server run harness:meal-read
# candidates + trials + output file:
pnpm --filter @workspace/api-server run harness:meal-read -- \
  --efforts default,none,low --trials 1 --out results/2026-08-27.md
```

`default` (always required — it is the baseline) means the effort knob is
**omitted**, exactly as production sends it. Other efforts are pinned via
`experimentReasoningEffort`, the harness-only hook on
`generateMealPhotoAnalysis` — nothing request-reachable can set it.

## Reading the report

Per plate: each read's outcome, meal name, item list with portions and
calories, latency, and reasoning tokens (from the same usage plumbing the
route logs). Each candidate gets a PARITY / DIFFERENT verdict vs the default
read: same normalized item-name set, per-item calories within ±15%, total
within ±10%. The verdict is deliberately conservative — a renamed item
counts as a difference; the recorded outputs let a human overrule pure
wording mismatches, but the burden of proof is on the candidate. Reads are
stochastic: for borderline candidates, re-run with `--trials 2` and require
parity on every trial.
