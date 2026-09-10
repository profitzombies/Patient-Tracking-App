/**
 * Stall-nudge trigger and outreach guardrails check.
 *
 * The coach's proactive outreach fires only when BOTH signals hold: weight
 * flat for ~3 weeks AND repeated off-plan diary items. This suite freezes
 * the guardrails with synthetic fixtures built at wide margins (an on-plan
 * stall, sparse or stale data, real progress must never trigger), the
 * seeding gate rules (one nudge per cooldown, stop on engagement, opt-out),
 * the seeded demo patient's own trigger snapshot, and the wire contract with
 * the api server (the outreach offer string must stay byte-identical, since
 * the server keys its back-on-track branch on it in replayed history).
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:stall-nudge
 */
import fs from 'node:fs';
import {
  BACK_ON_TRACK_OFFER,
  NUDGE_COOLDOWN_DAYS,
  RECIPE_VERDICTS,
  STALL_MAX_DROP_LB,
  assessNudge,
  classifyEntries,
  classifyEntry,
  shiftDateKey,
  shouldSeedOutreach,
  shouldSendOutreach,
  shouldRenderStandingOutreach,
  type ClassifiedEntry,
  type EntryVerdict,
  type OutreachGateState,
  type WeighIn,
} from '../data/stall-nudge';
import {
  buildSeedCheckIns,
  buildSeedEntries,
  PATIENT_PROFILE,
  toDateKey,
  TODAY_KEY,
} from '../data/patient-data';

let checks = 0;
let failures = 0;

function assert(label: string, condition: boolean) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label} = ${e}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}: expected ${e}, got ${a}`);
  }
}

/** Day key `offset` days before the demo anchor. */
const d = (offset: number) => shiftDateKey(TODAY_KEY, -offset);

/** `days` diary days ending today, each logging the given verdicts. */
function entriesFor(days: number, verdictsPerDay: EntryVerdict[]): ClassifiedEntry[] {
  const out: ClassifiedEntry[] = [];
  for (let offset = 0; offset < days; offset++) {
    for (const verdict of verdictsPerDay) out.push({ dateKey: d(offset), verdict });
  }
  return out;
}

/** Weigh-ins every `stepDays` from `spanDays` ago through today, ascending. */
function weighInsFor(spanDays: number, stepDays: number, weightAt: (offset: number) => number): WeighIn[] {
  const out: WeighIn[] = [];
  for (let offset = spanDays; offset >= 0; offset -= stepDays) {
    out.push({ dateKey: d(offset), weight: weightAt(offset) });
  }
  return out.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}

console.log('— Synthetic trigger fixtures —');

eq(
  'shared USDA catalog UUID stays unknown without a reviewed approved-food citation',
  classifyEntry({ kind: 'food', refId: '9d040db5-1092-47a8-a8aa-191225e47b4a' }),
  'unknown',
);

// Textbook trigger: half the diary off-plan for two weeks while weigh-ins
// wobble ±0.2 lb around 170 for three weeks. Wobble is normal day-to-day
// noise, so the stall detector must see through it.
const mixedDiary = entriesFor(14, ['aligned', 'aligned', 'off_plan', 'off_plan']);
const flatWobble = weighInsFor(20, 2, (offset) => (offset % 4 === 0 ? 170.2 : 169.8));
const activeCase = assessNudge(mixedDiary, flatWobble, TODAY_KEY);
assert('flat wobble + repeated off-plan triggers', activeCase.active);
assert('trigger tolerates day-to-day wobble (stalled)', activeCase.stall.stalled);
// The streak walk-back: adherence needs 8+ logged days in its window, so the
// oldest day this exact fixture supports is 6 days back.
eq('crossing day = first day of the contiguous active streak', activeCase.crossedOnKey, d(6));

// Guardrail: a stall with an on-plan diary NEVER triggers this nudge.
const onPlanDiary = entriesFor(14, ['aligned', 'aligned', 'aligned', 'aligned']);
const onPlanStall = assessNudge(onPlanDiary, flatWobble, TODAY_KEY);
assert('on-plan stall stays quiet', !onPlanStall.active);
assert('on-plan stall still reads as stalled (weight signal alone)', onPlanStall.stall.stalled);
assert('on-plan diary is not repeated off-plan', !onPlanStall.adherence.repeatedOffPlan);

// Guardrail: sparse weigh-ins are unknown, never stalled.
const sparseWeighIns = [
  { dateKey: d(16), weight: 170 },
  { dateKey: d(9), weight: 170 },
  { dateKey: d(1), weight: 170 },
];
const sparseCase = assessNudge(mixedDiary, sparseWeighIns, TODAY_KEY);
assert('3 weigh-ins = unknown, not stalled', !sparseCase.stall.stalled);
eq('sparse weigh-ins leave dropLb null', sparseCase.stall.dropLb, null);
assert('sparse weigh-ins never trigger', !sparseCase.active);

// Guardrail: enough weigh-ins but bunched into a narrow span = unknown.
const narrowSpan = assessNudge(mixedDiary, weighInsFor(8, 2, () => 170), TODAY_KEY);
assert('narrow weigh-in span (8d) = unknown, not stalled', !narrowSpan.stall.stalled);
assert('narrow span never triggers', !narrowSpan.active);

// Guardrail: a stale scale (newest weigh-in too old) = unknown.
const staleWeighIns = weighInsFor(20, 2, () => 170).filter((w) => w.dateKey <= d(8));
const staleCase = assessNudge(mixedDiary, staleWeighIns, TODAY_KEY);
assert('newest weigh-in 8 days old = unknown, not stalled', !staleCase.stall.stalled);
assert('stale weigh-ins never trigger', !staleCase.active);

// Guardrail: real progress never triggers, off-plan diary or not.
const losing = assessNudge(mixedDiary, weighInsFor(20, 2, (offset) => 168 + offset * 0.1), TODAY_KEY);
assert('steady loss is not a stall', !losing.stall.stalled);
assert(
  'steady loss exceeds the stall drop threshold',
  losing.stall.dropLb !== null && losing.stall.dropLb > STALL_MAX_DROP_LB,
);
assert('steady loss never triggers', !losing.active);

// Guardrail: a sparse diary (too few logged days) never triggers.
const sparseDiary = assessNudge(entriesFor(4, ['off_plan', 'off_plan', 'off_plan']), flatWobble, TODAY_KEY);
assert('4 logged days is too sparse to judge', !sparseDiary.active);

// Guardrail: no data at all is unknown everywhere.
const emptyCase = assessNudge([], [], TODAY_KEY);
eq(
  'empty record: inactive, drop and share and crossing all null',
  [emptyCase.active, emptyCase.stall.dropLb, emptyCase.adherence.offPlanShare, emptyCase.crossedOnKey],
  [false, null, null, null],
);

console.log('\n— Outreach gate (send once per episode, standing render, opt-out) —');

const crossing = activeCase.crossedOnKey!;
const gate = (partial: Partial<OutreachGateState>): OutreachGateState => ({
  optOut: false,
  engaged: false,
  lastSentKey: null,
  lastCrossingKey: null,
  ...partial,
});

// The SEND gate: at most one send per episode, cooldown-spaced across episodes.
assert('fresh state sends the outreach', shouldSendOutreach(activeCase, gate({}), TODAY_KEY));
assert('opt-out blocks the send', !shouldSendOutreach(activeCase, gate({ optOut: true }), TODAY_KEY));
assert(
  'an already-sent episode never sends again, even unanswered',
  !shouldSendOutreach(
    activeCase,
    gate({ lastCrossingKey: crossing, lastSentKey: TODAY_KEY }),
    TODAY_KEY,
  ),
);
assert(
  'an already-sent episode never sends again once engaged',
  !shouldSendOutreach(
    activeCase,
    gate({ engaged: true, lastCrossingKey: crossing, lastSentKey: TODAY_KEY }),
    TODAY_KEY,
  ),
);
assert(
  'a new episode inside the cooldown window stays quiet',
  !shouldSendOutreach(
    activeCase,
    gate({ lastCrossingKey: '2026-07-01', lastSentKey: d(NUDGE_COOLDOWN_DAYS - 1) }),
    TODAY_KEY,
  ),
);
assert(
  'a new episode after the cooldown window sends again',
  shouldSendOutreach(
    activeCase,
    gate({ lastCrossingKey: '2026-07-01', lastSentKey: d(NUDGE_COOLDOWN_DAYS) }),
    TODAY_KEY,
  ),
);
assert(
  'engagement with an OLD episode does not block a new one past cooldown',
  shouldSendOutreach(
    activeCase,
    gate({ engaged: true, lastCrossingKey: '2026-07-01', lastSentKey: d(NUDGE_COOLDOWN_DAYS) }),
    TODAY_KEY,
  ),
);
assert(
  'an inactive trigger never sends, even with a fresh gate',
  !shouldSendOutreach(emptyCase, gate({}), TODAY_KEY),
);

// The STANDING-MESSAGE rule: persisted state says this episode's message was
// already sent and stands unanswered, so a reopened session-only thread
// re-renders that same single message. Not a second send — recordNudgeSent is
// idempotent per episode, so the cooldown anchor never moves.
assert(
  'a sent-and-unanswered episode renders its standing message',
  shouldRenderStandingOutreach(activeCase, gate({ lastCrossingKey: crossing, lastSentKey: TODAY_KEY })),
);
assert(
  'engagement clears the standing message',
  !shouldRenderStandingOutreach(
    activeCase,
    gate({ engaged: true, lastCrossingKey: crossing, lastSentKey: TODAY_KEY }),
  ),
);
assert(
  'opt-out clears the standing message',
  !shouldRenderStandingOutreach(
    activeCase,
    gate({ optOut: true, lastCrossingKey: crossing, lastSentKey: TODAY_KEY }),
  ),
);
assert(
  'an episode never sent has no standing message',
  !shouldRenderStandingOutreach(activeCase, gate({ lastCrossingKey: '2026-07-01', lastSentKey: '2026-07-01' })),
);
assert(
  'an inactive trigger has no standing message',
  !shouldRenderStandingOutreach(emptyCase, gate({ lastCrossingKey: crossing, lastSentKey: TODAY_KEY })),
);

// The composite the chat thread consumes: send now, or show the standing message.
assert('thread seeds on a fresh send', shouldSeedOutreach(activeCase, gate({}), TODAY_KEY));
assert(
  'thread re-shows the standing message on reopen (same one nudge)',
  shouldSeedOutreach(
    activeCase,
    gate({ lastCrossingKey: crossing, lastSentKey: TODAY_KEY }),
    TODAY_KEY,
  ),
);
assert(
  'thread stays quiet for a new episode inside the cooldown',
  !shouldSeedOutreach(
    activeCase,
    gate({ lastCrossingKey: '2026-07-01', lastSentKey: d(NUDGE_COOLDOWN_DAYS - 1) }),
    TODAY_KEY,
  ),
);

console.log('\n— Seeded demo patient (the record the app actually shows) —');

// Reproduce PatientContext's projections for a fresh install: seed diary
// entries classified, seed check-in weights plus the enrollment baseline.
const seededEntries = classifyEntries(buildSeedEntries());
const byDate = new Map<string, number>();
byDate.set(toDateKey(new Date(PATIENT_PROFILE.startDate)), PATIENT_PROFILE.startingWeight);
[...buildSeedCheckIns()]
  .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
  .forEach((c) => {
    if (typeof c.weight === 'number') byDate.set(c.dateKey, c.weight);
  });
const seededWeighIns = [...byDate.entries()]
  .map(([dateKey, weight]) => ({ dateKey, weight }))
  .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
const seeded = assessNudge(seededEntries, seededWeighIns, TODAY_KEY);

assert('the demo patient is mid-episode (trigger active)', seeded.active);
eq('demo crossing day', seeded.crossedOnKey, '2026-08-13');
eq(
  'demo adherence counts (loggedDays/classified/offPlan)',
  [seeded.adherence.loggedDays, seeded.adherence.classified, seeded.adherence.offPlan],
  [14, 55, 30],
);
assert(
  'demo off-plan share = 30/55',
  seeded.adherence.offPlanShare !== null &&
    Math.abs(seeded.adherence.offPlanShare - 30 / 55) < 1e-9,
);
eq(
  'demo weigh-in window (count/span)',
  [seeded.stall.weighIns, seeded.stall.spanDays],
  [10, 18],
);
assert(
  'demo drop sits inside the stall threshold',
  seeded.stall.dropLb !== null && Math.abs(seeded.stall.dropLb) <= STALL_MAX_DROP_LB,
);
assert(
  'opted-out patient never gets the outreach, trigger or not',
  !shouldSeedOutreach(seeded, gate({ optOut: true }), TODAY_KEY),
);

console.log('\n— Classifier spot checks —');

eq('approved food id is aligned', classifyEntry({ kind: 'food', refId: 'fd_apple' }), 'aligned');
eq('neutral id stays neutral', classifyEntry({ kind: 'food', refId: 'fd_coffee' }), 'neutral');
eq('non-catalog food id is unknown', classifyEntry({ kind: 'food', refId: 'custom_9' }), 'unknown');
eq('quick calories are unknown', classifyEntry({ kind: 'quick', refId: undefined }), 'unknown');
const seededRecipes = buildSeedEntries().filter((e) => e.kind === 'recipe');
assert('seed diary uses recipes', seededRecipes.length > 0);
assert(
  'every seeded recipe carries a curated verdict (no accidental unknowns)',
  seededRecipes.every((e) => e.refId !== undefined && RECIPE_VERDICTS[e.refId] !== undefined),
);

console.log('\n— Wire contract with the api server —');

const serverSource = fs.readFileSync(
  new URL('../../api-server/src/coach/back-on-track.ts', import.meta.url),
  'utf8',
);
assert(
  'server back-on-track branch keys on the EXACT mobile offer string',
  serverSource.includes(BACK_ON_TRACK_OFFER),
);
assert(
  'server accepts the EXACT accept-chip label (it is not a bare yes)',
  serverSource.includes('"Yes, set me up"'),
);
assert('offer ends on its question (chips ride it)', BACK_ON_TRACK_OFFER.trimEnd().endsWith('?'));
assert('offer carries no em/en dashes', !/[\u2013\u2014]/.test(BACK_ON_TRACK_OFFER));

// Outreach copy rules in the chat context: canned strings carry no em/en
// dashes, and the two acknowledgment closers never end with "?" (only
// bubbles carrying their own chips may).
const chatSource = fs.readFileSync(
  new URL('../context/CoachChatContext.tsx', import.meta.url),
  'utf8',
);
assert(
  "outreach bubble keeps its fixed id 'coach-outreach'",
  /OUTREACH_MESSAGE_ID = ['"]coach-outreach['"]/.test(chatSource),
);
const constantPattern =
  /const (NUDGE_[A-Z_]+|OUTREACH_ACCEPT|OUTREACH_DECLINE)\s*=\s*\n?\s*(['"])(.*?)\2;/g;
const foundConstants = new Map<string, string>();
for (const match of chatSource.matchAll(constantPattern)) {
  foundConstants.set(match[1]!, match[3]!);
}
for (const name of [
  'OUTREACH_ACCEPT',
  'OUTREACH_DECLINE',
  'NUDGE_KEEP_WATCH',
  'NUDGE_PAUSE',
  'NUDGE_DECLINE_ASK',
  'NUDGE_KEEP_ACK',
  'NUDGE_PAUSE_ACK',
]) {
  const value = foundConstants.get(name);
  assert(`${name} exists as a string constant`, value !== undefined);
  if (value === undefined) continue;
  assert(`${name} carries no em/en dashes`, !/[\u2013\u2014]/.test(value));
}
for (const name of ['NUDGE_KEEP_ACK', 'NUDGE_PAUSE_ACK']) {
  const value = foundConstants.get(name) ?? '';
  assert(`${name} never ends with "?"`, !value.trimEnd().endsWith('?'));
}
// Close the loop on the accept-chip wire contract: the mobile label is the
// exact string the server-side check above looked for.
eq('OUTREACH_ACCEPT is the label the server keys on', foundConstants.get('OUTREACH_ACCEPT'), 'Yes, set me up');
assert(
  'the decline ask ends with "?" (it carries its own chips)',
  (foundConstants.get('NUDGE_DECLINE_ASK') ?? '').trimEnd().endsWith('?'),
);

// Check-in surface wiring: the supportive note reads the same shared
// trigger, links into the coach chat, and offers the opt-out.
const checkInSource = fs.readFileSync(new URL('../app/check-in.tsx', import.meta.url), 'utf8');
assert('check-in note reads the shared assessment', checkInSource.includes('nudgeAssessment.active'));
assert('check-in note hides once engaged', checkInSource.includes('nudgeEngaged'));
assert('check-in note opens Coach conversation history', checkInSource.includes("router.push('/coach-history'"));
assert('check-in note offers the opt-out', checkInSource.includes('setNudgeOptOut(true)'));
assert('paused row offers resume', checkInSource.includes('setNudgeOptOut(false)'));

console.log(`\n${checks} checks, ${failures} failure(s).`);
if (failures > 0) process.exit(1);
console.log('All stall-nudge checks passed.');
