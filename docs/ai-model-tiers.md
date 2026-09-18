# AI model tiers — cost, caching, and the cheaper-tier evaluation

Recorded 2026-09-18. This is the written result the model knobs in
`artifacts/api-server/src/ai/models.ts` point to. Re-run the harnesses and
append a dated section before changing any default.

## Summary

| Surface | Default model | Cheaper tier tested | Verdict |
|---|---|---|---|
| `coach.chat` | `gpt-5.6-terra` | `gpt-5.4-mini` | **Not adopted.** Grounding and referral hold; the one-tap reply marker disappears entirely (0/20 vs 7/20) and closers drift from questions to offers. |
| `coach.meal_photo` | `gpt-5.6-luna` | `gpt-5.4-mini` | **Not adopted.** Parity on 0/6 plates: totals 20-40% low, items renamed and dropped. Photo, label, and menu reads stay on their defaults by rule. |
| all others | unchanged | not evaluated | Defaults unchanged. |

Every surface keeps today's model. The per-surface knobs
(`AI_MODEL_COACH_CHAT`, `AI_MODEL_COACH_MEAL_PHOTO`, `AI_MODEL_SUPPORT_CHAT`, …;
see `modelKnobName`) exist so staging can point one surface at another model
without touching the rest, and so a future tier that passes the gate is a
one-variable change with the current model as the default.

## How usage is measured

Every call through the shared OpenAI client (`lib/integrations-openai-ai-server`)
is metered at the client seam (`instrumentOpenAI`): model, prompt tokens,
cached prompt tokens as reported by the provider, completion and reasoning
tokens, latency, and error state. The API server attributes each call to an
account or office and a surface through request context
(`src/ai-usage/context.ts`), buffers rows, and writes them in batches to
`public.ai_usage_events` (`AI_USAGE_LEDGER=off|memory|database`). Nothing on
the reply path awaits the ledger.

Cost is an estimate: `cost_micros` is computed at write time from the rate
table in `src/ai-usage/pricing.ts` (`PRICING_VERSION` is stored on each row),
overridable with `AI_MODEL_PRICING_JSON`. A model with no rate stores a null cost
and the HQ panel reports it as unpriced rather than as zero. The gateway's
`gpt-5.6-terra` / `gpt-5.6-luna` names are priced at the flagship gpt-5 tier
($1.25 / $0.125 cached / $10 per 1M tokens), `gpt-5.4-mini` at the mini tier
($0.25 / $0.025 / $2), `gpt-5-nano` at the nano tier ($0.05 / $0.005 / $0.40).
These are assumptions about the gateway's billing, not confirmed invoices;
correct the table when a real statement arrives and bump `PRICING_VERSION`.

HQ reads the ledger through `GET /api/billing/hq/ai-costs?from&to`
(`ai_usage_summary` RPC): totals, per day, per office, per surface, per model,
per active patient, and the cached-token share. The panel is the "AI costs"
tab under HQ Payments.

## Prompt caching: what the rows showed

The provider caches whole-message prefixes of at least 1024 tokens and reuses
a stored prefix only through a user-message boundary. Three layouts of the
coach chat prompt were measured live on the same six-turn conversation, with
the cached-token count read back from the ledger rows:

| Layout | Cached tokens on turns 1-6 |
|---|---|
| Stable prefix first, per-turn sources in a block **after** the history | ≤ 1,057 on every turn (only the prefix and history ever hit; the 2.5-7k tokens of sources never did) |
| One system message: persona, patient line, rules, sources in canonical order, product block | 0, 0, 8,010, 8,084, 8,150, 8,293 (of 8,087-8,425) |
| Same, on a fresh run of the same six turns | 3,534, 0, 8,012, 8,078, 8,162, 8,329 |

The zero on turn two is the source set changing between turns (the selector
picked a different compartment set), not a cache miss on identical bytes:
with the same set, follow-ups reuse about 99% of the prompt. This is why
`sourcesBlock` orders compartments by the `COMPARTMENTS` registry, not by
score: the same set must always produce the same bytes.

Two layouts that did cache better in isolation were rejected because they
changed the reply: putting the patient line after the rules (so the head is
shared across patients) or moving the per-turn material after the question
cut the optional one-tap reply marker from 13/24 replies to 7/24. The chips
are part of the reply shape, so the shipped layout is the pre-task wording and
order with the canonical source order added. The other builders (recipe, meal
chat, back-on-track, menu scan, meal photo, label photo) now place their
static instructions before the per-call content.

In the HQ panel this shows up as the "prompt cache share" tile; a healthy
coach-chat day sits well above half once conversations run past two turns.

## Coach chat: `gpt-5.6-terra` vs `gpt-5.4-mini`

Harness: `pnpm --filter @workspace/api-server run harness:coach-chat -- --models default,gpt-5.4-mini --trials 2`
(`artifacts/api-server/scripts/coach-chat-harness/run.ts`; full replies in
`scripts/coach-chat-harness/results/2026-09-18.md`). It sends the production
chat prompt (same selector, same system prompt, same message assembly as the
`/coach/chat` route) for ten fixed patient questions, two trials each, and
checks each reply for: quoted spans and every number-with-unit appearing
verbatim in the sources given; a care-team referral on the two out-of-scope
questions (ibuprofen, keto + fasting); 2-4 blocks; the one-tap marker; no
dashes, markdown, emoji, stock openers, or brand misspelling.

| model | replies | grounding | referral | shape | marker | voice | words | latency mean / p95 | reasoning tok | cost per reply |
|---|---|---|---|---|---|---|---|---|---|---|
| gpt-5.6-terra (default) | 20/20 | 100% | 100% | 100% | 35% | 95% | 62 | 3.7s / 5.2s | 50 | $0.0020 |
| gpt-5.4-mini | 20/20 | 85% | 100% | 100% | 0% | 100% | 68 | 1.6s / 1.8s | 0 | $0.0005 |

Reading the flags by hand:

- The three mini "grounding" misses are checker artifacts, not fabrications:
  two quote the approved-foods line "All 0-Calorie sauces, seasonings, and
  dressings are approved", which the two-column PDF transcription splits
  across a column break, and one renders the nested quote "Heart Healthy"
  with single quotes. Terra quoted the same line in an earlier run. On a human
  read both models quote program wording verbatim on every question and both
  send the ibuprofen and keto questions to the care team without guessing.
- Terra's one voice miss is an en dash ("1–2 pasture-raised eggs") that the
  route's dash smoother strips in production; the harness reads the raw model
  output.
- The real difference is the reply shape. Terra emits the `[[replies:…]]`
  marker on 7 of 20 replies and closes with a question; mini never emits the
  marker and closes with "If you want, I can help…" offers instead. The
  one-tap chips are part of the coach reply contract, so this is a quality
  loss, not a style preference.

Decision: **keep `gpt-5.6-terra` for `coach.chat`.** Mini is 4x cheaper per
reply and roughly 2x faster, which is worth revisiting once the marker
instruction has been made robust enough that the cheaper tier follows it; that
is a prompt change with its own chip-rate measurement, not part of this
evaluation. Cached prompt tokens were counted on every second trial for both
models (for example 5,375 of 5,378), confirming the layout above caches across
models.

## Meal photo: `gpt-5.6-luna` vs `gpt-5.4-mini`

Harness: `pnpm --filter @workspace/api-server run harness:meal-read -- --efforts default --models default,gpt-5.4-mini`
(`scripts/meal-read-harness/run.ts`; report in
`scripts/meal-read-harness/results/2026-09-18-tiers.md`). The harness now
takes `--models` and pins the candidate through `AI_MODEL_COACH_MEAL_PHOTO`
for each read, so the candidate runs the identical production code path.

- **`gpt-5.4-mini`: parity on 0/6 plates.** Totals ran 20-40% under the
  default read (roast and gravy 810 vs 1,120 kcal; loaded chili 746 vs 1,190;
  chicken curry 735 vs 1,080), items were renamed on every plate and dropped
  on three (shredded cheese, black coffee, water). Reads took 1.5-2s with no
  reasoning tokens.
- The rule from 2026-08 stands: photo, label, and menu reads do not move to
  a lower tier. The knobs remain for staging only.

## Re-running

Both harnesses make live model calls and cost real tokens (this run was
roughly $0.25 in total). Commit the result files, add a dated section here,
and change a default in `src/ai/models.ts` only when the candidate reaches
parity on every check that matters for that surface.
