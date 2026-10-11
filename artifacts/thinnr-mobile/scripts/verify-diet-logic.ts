/**
 * Diet logic suite — the pure helpers behind the patient diet surfaces, run
 * under Node with no network, no database and no React:
 *
 *  - the eating-window clock and the Whole30 day counter (day-31 prompt),
 *  - the weekly check-in cadence for the activity question,
 *  - onboarding → diet writes (never throws, never blocks completion),
 *  - the one-time prompt rule for accounts that finished onboarding before
 *    the diet steps existed,
 *  - the coach / classifier contexts derived from the diet slice,
 *  - queue projection (local ids, severity, removal, targets overrides),
 *  - the targets override draft → write mapping,
 *  - the catalog classifier bridge (Approved Foods decides during the protocol),
 *  - the food-description seam: a shared-catalog hit's `approved: false` is
 *    "no approval recorded", never "not approved" (unknown → no badge),
 *  - queue reconciliation never trims diet edits against diary/library truth.
 *
 * It also pins two source-level contracts on the check-in screen: it asks the
 * activity question on the weekly cadence and records it on the diet ledger
 * without holding the check-in hostage.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:diet-logic
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activityDueForCheckIn,
  coachDietContextFor,
  demoDietState,
  eatingWindowStatus,
  fastingWindowFor,
  fitContextFor,
  formatDuration,
  FASTING_PRESETS,
  isLocalPreferenceId,
  LOCAL_PREFERENCE_PREFIX,
  presetForWindow,
  projectDietQueue,
  projectDietWrite,
  projectTargetsQueue,
  providerChangedDiet,
  whole30Status,
  type DietPreference,
  type DietState,
  type DietTargetsState,
} from '@/lib/diet-state';
import { classifyCatalogFood, type ClassifierContext } from '@/lib/diet-fit';
import { approvedFlagFor, describeFood, type DescribableFood } from '@/lib/food-description';
import { dietSettingsFor, dietWritesFor, type DietWriteSink } from '@/lib/onboarding-diet-writes';
import { needsDietPrompt, DIET_PROMPT_SEEN_KEY } from '@/components/diet/TodayDietCards';
import { overridesForDraft } from '@/components/diet/TargetsEditor';
import { DEFAULT_ANSWERS, type OnboardingAnswers } from '@/data/onboarding-data';
import { reconcileQueue, type QueuedWrite } from '@/lib/patient-write-queue';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}`);
  }
}
function section(title: string): void {
  console.log(`\n· ${title}`);
}

const TODAY = '2026-10-10';
const pref = (over: Partial<DietPreference>): DietPreference => ({
  id: 'p1',
  list: 'allergy',
  key: 'peanut',
  label: 'Peanut',
  isCustom: false,
  severity: 'mild',
  enteredByRole: 'patient',
  enteredByName: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const queued = (payload: QueuedWrite['payload'], id = 'q1'): QueuedWrite => ({
  id,
  payload,
  summary: '',
  createdAt: 0,
  attempts: 0,
  nextAttemptAt: 0,
  status: 'pending',
  lastError: null,
  editsRowIds: [],
} as unknown as QueuedWrite);

// Maintenance-phase state (episode long finished) and protocol state (day 10).
const maintenance: DietState = demoDietState(TODAY, '2026-01-05');
const protocol: DietState = demoDietState(TODAY, '2026-10-01');

async function main() {
  section('eating window clock');
  const window = fastingWindowFor(FASTING_PRESETS[0], '12:00');
  assert('16:8 from noon closes at 8 PM', window.eatingEnd === '20:00');
  assert('20:4 from 2 PM closes at 6 PM', fastingWindowFor(FASTING_PRESETS[3], '14:00').eatingEnd === '18:00');
  assert('a window crossing midnight wraps', fastingWindowFor(FASTING_PRESETS[2], '20:00').eatingEnd === '06:00');
  const open = eatingWindowStatus(window, 13 * 60);
  assert('1 PM is inside the window with 7 hours left', open.eating && open.minutesRemaining === 420 && open.nextChangeAt === '20:00');
  const closed = eatingWindowStatus(window, 22 * 60);
  assert('10 PM is fasting, opens again in 14 hours', !closed.eating && closed.minutesRemaining === 840 && closed.nextChangeAt === '12:00');
  const edge = eatingWindowStatus(window, 20 * 60);
  assert('the closing minute counts as fasting', !edge.eating && edge.minutesRemaining === 960);
  const overnight = eatingWindowStatus({ eatingStart: '20:00', eatingEnd: '06:00' }, 2 * 60);
  assert('2 AM inside an overnight window is open', overnight.eating && overnight.minutesRemaining === 240);
  assert('presets resolve back from a stored window', presetForWindow(window)?.id === '16:8' && presetForWindow({ eatingStart: '09:00', eatingEnd: '21:00' }) === null);
  assert('durations read in hours and minutes', formatDuration(420) === '7 hr' && formatDuration(95) === '1 hr 35 min' && formatDuration(40) === '40 min');

  section('Whole30 counter');
  assert('day 10 of 30 on 10-10 from a 10-01 start', JSON.stringify(whole30Status('2026-10-01', TODAY)) === JSON.stringify({ day: 10, finished: false, daysLeft: 21 }));
  assert('day 30 is the last day, not finished', whole30Status('2026-09-11', TODAY).day === 30 && !whole30Status('2026-09-11', TODAY).finished);
  const day31 = whole30Status('2026-09-10', TODAY);
  assert('day 31 is finished with zero days left', day31.day === 31 && day31.finished && day31.daysLeft === 0);
  assert('starting today is day 1', whole30Status(TODAY, TODAY).day === 1);

  section('weekly activity cadence');
  assert('never recorded → due', activityDueForCheckIn(null, TODAY));
  assert('recorded today → not due', !activityDueForCheckIn({ level: 'light', source: 'check_in', recordedOn: TODAY }, TODAY));
  assert('recorded 6 days ago → not due', !activityDueForCheckIn({ level: 'light', source: 'check_in', recordedOn: '2026-10-04' }, TODAY));
  assert('recorded 7 days ago → due', activityDueForCheckIn({ level: 'light', source: 'check_in', recordedOn: '2026-10-03' }, TODAY));
  assert('an unreadable date fails open (asks again)', activityDueForCheckIn({ level: 'light', source: 'check_in', recordedOn: 'nope' }, TODAY));

  section('onboarding → diet writes');
  const calls: string[] = [];
  const sink = (fail: boolean): DietWriteSink => ({
    queueDietSelection: async input => { calls.push(`select:${input.dietSlug}:${input.activityLevel ?? ''}:${JSON.stringify(input.settings ?? null)}`); if (fail) throw new Error('boom'); return true; },
    saveDietActivity: async (level, source) => { calls.push(`activity:${level}:${source}`); if (fail) throw new Error('boom'); return true; },
    addDietPreference: async input => { calls.push(`add:${input.list}:${input.key ?? '-'}:${input.label}:${input.severity ?? '-'}`); if (fail) throw new Error('boom'); return true; },
  });
  const answers: OnboardingAnswers = {
    ...DEFAULT_ANSWERS,
    dietSlug: 'intermittent_fasting',
    dietAnswers: { medication: 'no' },
    fastingPreset: '18:6',
    fastingStart: '11:00',
    activityLevel: 'moderate',
    allergiesNone: false,
    allergies: [{ key: 'peanut', label: 'Peanut', severity: 'severe' }, { key: 'milk', label: 'Milk' }],
    sensitivities: [{ key: 'lactose', label: 'Lactose' }],
    restrictions: [{ key: 'halal', label: 'Halal' }],
    dislikes: [{ key: null, label: 'Cilantro' }],
  };
  assert('fasting answers become an 11:00–17:00 window', JSON.stringify(dietSettingsFor(answers)) === JSON.stringify({ fastingWindow: { eatingStart: '11:00', eatingEnd: '17:00' } }));
  assert('Whole30 start date rides settings', dietSettingsFor({ ...DEFAULT_ANSWERS, dietSlug: 'whole30', whole30StartDate: TODAY })?.whole30StartDate === TODAY);
  assert('other diets carry no settings', dietSettingsFor({ ...DEFAULT_ANSWERS, dietSlug: 'keto' }) === undefined);
  await dietWritesFor(answers, sink(false));
  assert('one selection then every list item, allergies default to mild', JSON.stringify(calls) === JSON.stringify([
    'select:intermittent_fasting:moderate:{"fastingWindow":{"eatingStart":"11:00","eatingEnd":"17:00"}}',
    'add:allergy:peanut:Peanut:severe',
    'add:allergy:milk:Milk:mild',
    'add:sensitivity:lactose:Lactose:-',
    'add:restriction:halal:Halal:-',
    'add:dislike:-:Cilantro:-',
  ]));
  calls.length = 0;
  await dietWritesFor({ ...DEFAULT_ANSWERS, activityLevel: 'active', allergiesNone: true }, sink(false));
  assert('no diet + "None" allergies writes only the activity level', JSON.stringify(calls) === JSON.stringify(['activity:active:diet_selection']));
  calls.length = 0;
  let threw = false;
  try {
    await dietWritesFor(answers, sink(true));
  } catch {
    threw = true;
  }
  assert('failing writes never throw out of the completion path', !threw && calls.length === 6);

  section('one-time prompt for existing accounts');
  const legacy = { ...maintenance, currentDiet: null, preferences: [] };
  assert('finished onboarding before the diet steps → prompt', needsDietPrompt({ onboardingComplete: true, onboardingAnswers: { notifications: 'enabled' }, diet: legacy }));
  assert('not finished onboarding → no prompt', !needsDietPrompt({ onboardingComplete: false, onboardingAnswers: {}, diet: legacy }));
  assert('answered the allergies step (even "None") → no prompt', !needsDietPrompt({ onboardingComplete: true, onboardingAnswers: { allergiesNone: true }, diet: legacy }));
  assert('already skipped once → no prompt', !needsDietPrompt({ onboardingComplete: true, onboardingAnswers: { [DIET_PROMPT_SEEN_KEY]: true }, diet: legacy }));
  assert('has a diet → no prompt', !needsDietPrompt({ onboardingComplete: true, onboardingAnswers: {}, diet: maintenance }));
  assert('has an allergy on file → no prompt', !needsDietPrompt({ onboardingComplete: true, onboardingAnswers: {}, diet: { ...legacy, preferences: [pref({})] } }));
  assert('diet slice not loaded → no prompt yet', !needsDietPrompt({ onboardingComplete: true, onboardingAnswers: {}, diet: null }));

  section('coach and classifier contexts');
  const withLists: DietState = {
    ...maintenance,
    preferences: [pref({}), pref({ id: 'p2', list: 'dislike', key: 'custom:cilantro', label: ' Cilantro ', isCustom: true, severity: null }), pref({ id: 'p3', list: 'restriction', key: 'halal', label: 'Halal', severity: null })],
  };
  const coach = coachDietContextFor(withLists);
  assert('coach context names the diet and splits avoid vs dislikes', coach?.dietSlug === 'mediterranean' && coach.dietName.length > 0
    && JSON.stringify(coach.avoid) === JSON.stringify(['Peanut', 'Halal']) && JSON.stringify(coach.dislikes) === JSON.stringify(['Cilantro']));
  assert('no diet and no lists → nothing to send', coachDietContextFor({ ...maintenance, currentDiet: null, effectiveDietSlug: null, preferences: [] }) === null);
  assert('lists alone still ride as just tracking', coachDietContextFor({ ...withLists, currentDiet: null, effectiveDietSlug: null })?.dietSlug === 'just_tracking');
  assert('no diet slice → no context', coachDietContextFor(null) === null && fitContextFor(null) === null);
  const protoCtx = fitContextFor({ ...protocol, effectiveDietSlug: 'keto' });
  assert('protocol phase hands the classifier no diet slug (Approved Foods decides)', protoCtx?.dietSlug === null && protoCtx.phase === 'protocol');
  const maintCtx = fitContextFor(withLists);
  assert('maintenance passes the effective diet and tagged preferences', maintCtx?.dietSlug === 'mediterranean'
    && maintCtx.preferences.some(p => p.key === 'custom:cilantro' && p.custom === true)
    && maintCtx.preferences.some(p => p.key === 'peanut' && p.severity === 'mild'));

  section('catalog classifier bridge');
  assert('approved food fits during the protocol', classifyCatalogFood({ name: 'Chicken breast' }, 'fd_chicken_breast', protoCtx!).verdict === 'fits');
  assert('an unlisted seeded catalog food does not fit during the protocol', classifyCatalogFood({ name: 'Croissant' }, 'fd_croissant', protoCtx!).verdict === 'does_not_fit');
  // No membership evidence → unknown (no badge), never a definitive "doesn't fit".
  assert('a patient-created food is unknown during the protocol', classifyCatalogFood({ name: 'Grandma casserole' }, 'custom_1', protoCtx!).verdict === 'unknown');
  assert('a recipe is unknown during the protocol', classifyCatalogFood({ name: 'Yogurt bowl', ingredients: ['Greek yogurt', 'berries'] }, 'rec_yogurt_bowl', protoCtx!).verdict === 'unknown');
  assert('a coach recipe is unknown during the protocol', classifyCatalogFood({ name: 'Turkey chili' }, 'airec_7', protoCtx!).verdict === 'unknown');
  assert('a food without an id is unknown during the protocol', classifyCatalogFood({ name: 'Mystery' }, undefined, protoCtx!).verdict === 'unknown');
  assert('an explicit not-approved flag still fails the protocol', classifyCatalogFood({ name: 'Shared hit', thinnrApproved: false }, 'off:12345', protoCtx!).verdict === 'does_not_fit');
  assert('an explicit approved flag wins over the id bridge', classifyCatalogFood({ name: 'Mystery', thinnrApproved: true }, undefined, { ...protoCtx!, preferences: [] }).verdict === 'fits');
  assert('a recorded allergy still fires during the protocol', classifyCatalogFood({ name: 'Peanut chicken', allergens: ['peanut'] }, 'fd_chicken_breast', protoCtx!).verdict === 'does_not_fit');
  const ketoCtx = { ...maintCtx!, dietSlug: 'keto' };
  assert('maintenance keto: a 40 g carb serving does not fit', classifyCatalogFood({ name: 'Rice', tags: ['grain'], carbsPerServing: 40 }, 'fd_rice', ketoCtx).verdict === 'does_not_fit');
  const peanutHit = classifyCatalogFood({ name: 'Peanut butter', allergens: ['peanut'], carbsPerServing: 6 }, 'fd_pb', ketoCtx);
  assert('a recorded allergy beats the diet verdict', peanutHit.verdict === 'does_not_fit' && peanutHit.reasons.some(r => r.source === 'allergy'));
  assert('maintenance ignores the Approved Foods list', classifyCatalogFood({ name: 'Chicken breast', tags: ['poultry'], carbsPerServing: 0 }, 'fd_chicken_breast', ketoCtx).verdict === 'fits');
  assert('a food with no facts is unknown under a diet', classifyCatalogFood({ name: 'Something' }, 'fd_x', ketoCtx).verdict === 'unknown');

  section('food description → fit (the screens\' path)');
  // The shape every screen hands the classifier: describeFood() first, then
  // the catalog bridge — exactly what foodFitFor().classify does.
  const fitFor = (food: DescribableFood, ctx: ClassifierContext) => classifyCatalogFood(describeFood(food), food.id ?? food.refId, ctx).verdict;
  // A shared-catalog search hit as lib/food-catalog parses it: `approved`
  // is false whenever no approval was recorded, which says nothing about
  // the Approved Foods list.
  const sharedHit = { id: 'usda:171477', refId: 'usda:171477', name: 'Yogurt, Greek, plain', brand: undefined, calories: 59, carbs: 3.6, approved: false, servingGrams: 100 };
  assert('a shared search hit with approved:false is unknown during the protocol (no badge)', fitFor(sharedHit, protoCtx!) === 'unknown');
  assert('its private snapshot (catalogApproved:false) is unknown too', fitFor({ id: 'usda:171477', name: 'Yogurt, Greek, plain', catalogShared: true, catalogApproved: false } as DescribableFood, protoCtx!) === 'unknown');
  assert('a branded hit with approved:false is unknown during the protocol', fitFor({ id: 'off:0049000050103', name: 'Cola', brand: 'Coca-Cola', calories: 140, carbs: 39, approved: false }, protoCtx!) === 'unknown');
  assert('a recorded approval on a shared hit fits during the protocol', fitFor({ id: 'usda:171477', name: 'Yogurt, Greek, plain', approved: true }, { ...protoCtx!, preferences: [] }) === 'fits');
  assert('a seeded id off the list with approved:false does not fit', fitFor({ id: 'fd_croissant', name: 'Croissant', approved: false }, protoCtx!) === 'does_not_fit');
  assert('a seeded id on the list fits regardless of a stale flag', fitFor({ id: 'fd_chicken_breast', name: 'Chicken breast', approved: false }, { ...protoCtx!, preferences: [] }) === 'fits');
  assert('approvedFlagFor exposes the same evidence rule', approvedFlagFor(sharedHit) === undefined && approvedFlagFor({ id: 'fd_croissant', name: 'Croissant', catalogApproved: false }) === false && approvedFlagFor({ id: 'custom_1', name: 'Mine', approved: false }) === undefined);
  assert('a shared hit the patient is allergic to still does not fit', fitFor({ id: 'usda:1', name: 'Peanut butter', approved: false }, protoCtx!) === 'does_not_fit');
  assert('under a diet a shared hit is judged on its facts, not the flag', fitFor({ id: 'usda:2', name: 'White rice, cooked', carbs: 45, approved: false }, ketoCtx) === 'does_not_fit');

  section('queue reconciliation keeps diet edits');
  const emptyTruth = { addedEntries: [], customFoods: [], savedRecipes: [], photos: [] };
  const dietEdits = [
    queued({ kind: 'dietPreferenceSeverity', id: 'srv-1', severity: 'severe' }, 'a'),
    queued({ kind: 'dietPreferenceRemove', id: 'srv-2' }, 'b'),
    queued({ kind: 'dietPreferenceAdd', item: pref({ id: `${LOCAL_PREFERENCE_PREFIX}xyz`, list: 'dislike', key: 'custom:okra', label: 'Okra', isCustom: true, severity: null }) }, 'c'),
    queued({ kind: 'dietTargets', overrides: { calories: 1700 } }, 'd'),
  ];
  assert('diet edits survive reconciliation against diary/library truth', reconcileQueue(dietEdits, emptyTruth).map(q => q.id).join(',') === 'a,b,c,d');
  const stampedEdits = dietEdits.map(q => ({ ...q, editIds: ['srv-1'] }));
  assert('even with stray editIds, diet edits are never trimmed (restart / refresh path)', reconcileQueue(stampedEdits, emptyTruth).length === 4);
  const entryEdit = { ...queued({ kind: 'entries', upsert: [{ id: 'e-gone' }] } as unknown as QueuedWrite['payload'], 'e'), editIds: ['e-gone'] };
  assert('an entry edit of a vanished row is still dropped', reconcileQueue([entryEdit, ...dietEdits], emptyTruth).length === 4);

  section('queue projection');
  const localItem = pref({ id: `${LOCAL_PREFERENCE_PREFIX}abc`, list: 'dislike', key: 'custom:mushrooms', label: 'Mushrooms', isCustom: true, severity: null });
  assert('local ids are recognisable', isLocalPreferenceId(localItem.id) && !isLocalPreferenceId('row-1'));
  const base: DietState = { ...maintenance, preferences: [pref({})] };
  const added = projectDietWrite(base, { kind: 'dietPreferenceAdd', item: localItem });
  assert('a queued add shows immediately', added?.preferences.length === 2 && added.preferences[1].id === localItem.id);
  assert('a duplicate add is ignored', projectDietWrite(added, { kind: 'dietPreferenceAdd', item: { ...localItem, id: 'other' } })?.preferences.length === 2);
  assert('severity edits project', projectDietWrite(base, { kind: 'dietPreferenceSeverity', id: 'p1', severity: 'severe' })?.preferences[0].severity === 'severe');
  assert('removals project', projectDietWrite(added, { kind: 'dietPreferenceRemove', id: localItem.id })?.preferences.length === 1);
  const selected = projectDietWrite(base, { kind: 'dietSelection', dietSlug: 'keto', answers: { medication: 'no' }, activityLevel: 'active' });
  assert('a queued selection projects the diet, answers and activity', selected?.currentDiet?.dietSlug === 'keto' && selected.effectiveDietSlug === 'keto'
    && selected.screening.answers.medication === 'no' && selected.activityLevel?.level === 'active' && selected.activityLevel.source === 'diet_selection');
  const lockedSel = projectDietWrite(protocol, { kind: 'dietSelection', dietSlug: 'keto' });
  assert('a selection cannot project through the protocol lock', lockedSel?.currentDiet === protocol.currentDiet && lockedSel?.effectiveDietSlug === null);
  const settingsOnly = projectDietWrite(base, { kind: 'dietSettings', settings: { fastingWindow: window } });
  assert('settings merge onto the current diet', settingsOnly?.currentDiet?.settings.fastingWindow?.eatingEnd === '20:00');
  assert('settings without a diet are a no-op', projectDietWrite({ ...base, currentDiet: null }, { kind: 'dietSettings', settings: { fastingWindow: window } })?.currentDiet === null);
  const chain = projectDietQueue(base, [
    queued({ kind: 'dietPreferenceAdd', item: localItem }, 'a'),
    queued({ kind: 'dietPreferenceSeverity', id: 'p1', severity: 'severe' }, 'b'),
    queued({ kind: 'logWater', dateKey: TODAY, ounces: 8 } as unknown as QueuedWrite['payload'], 'c'),
    queued({ kind: 'dietActivity', level: 'light', source: 'check_in', recordedOn: TODAY }, 'd'),
  ]);
  assert('the queue projects in order and skips non-diet writes', chain?.preferences.length === 2 && chain.preferences[0].severity === 'severe' && chain.activityLevel?.level === 'light');
  assert('projection on a null base stays null', projectDietQueue(null, [queued({ kind: 'dietPreferenceAdd', item: localItem })]) === null);

  const targets: DietTargetsState = {
    dateKey: TODAY,
    calculated: { calories: 1650, protein: 130, carbs: 140, fat: 55, waterOz: 80 },
    effective: { calories: 1650, protein: 130, carbs: 140, fat: 55, waterOz: 80 },
    overrides: { calories: null, protein: null, carbs: null, fat: null, waterOz: null },
    overridden: [],
    missing: [],
    activityLevel: 'moderate',
  };
  const projected = projectTargetsQueue(targets, [queued({ kind: 'dietTargets', overrides: { calories: 1700 } })]);
  assert('a queued override changes the effective number', projected?.effective.calories === 1700 && projected.overridden.includes('calories') && projected.overrides.calories === 1700);
  const reset = projectTargetsQueue(projected!, [queued({ kind: 'dietTargets', overrides: { calories: null } })]);
  assert('a queued reset returns to the calculated number', reset?.effective.calories === 1650 && reset.overridden.length === 0);
  assert('no targets writes → same object', projectTargetsQueue(targets, [queued({ kind: 'dietActivity', level: 'light', source: 'check_in', recordedOn: TODAY })]) === targets);

  section('targets override draft');
  assert('only changed fields are written', JSON.stringify(overridesForDraft(targets, { ...targets.calculated, calories: 1700 })) === JSON.stringify({ calories: 1700 }));
  assert('matching the calculated value clears an existing override', JSON.stringify(overridesForDraft(projected!, { ...targets.calculated })) === JSON.stringify({ calories: null }));
  assert('an unchanged draft writes nothing', JSON.stringify(overridesForDraft(targets, { ...targets.calculated })) === '{}'
    && JSON.stringify(overridesForDraft(projected!, { ...targets.calculated, calories: 1700 })) === '{}');

  section('provider-changed-diet notice');
  const providerSel = { ...maintenance, currentDiet: { ...maintenance.currentDiet!, id: 'sel-staff', selectedByRole: 'staff' } };
  assert('a staff-set diet shows until dismissed', providerChangedDiet(providerSel, null)?.id === 'sel-staff' && providerChangedDiet(providerSel, 'sel-staff') === null);
  assert('a patient-set diet never shows the notice', providerChangedDiet(maintenance, null) === null);

  section('check-in screen contracts (source)');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const checkIn = readFileSync(path.join(here, '..', 'app', 'check-in.tsx'), 'utf8');
  assert('check-in asks on the weekly cadence', checkIn.includes('activityDueForCheckIn(recordedActivity, todayKey)'));
  assert('check-in records activity on the diet ledger without awaiting it', checkIn.includes("void patient.saveDietActivity(activityLevel, 'check_in')"));
  assert('the activity card only renders when the diet slice is live', checkIn.includes("patient.dietStatus === 'live'") && checkIn.includes('{dietLive && ('));
  const progress = readFileSync(path.join(here, '..', 'app', '(patient)', 'progress.tsx'), 'utf8');
  assert('Progress shows activity over time', progress.includes('ActivityHistoryCard'));

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
