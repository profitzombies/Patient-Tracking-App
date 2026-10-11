/**
 * Pure checks for the roster filter model: every operator on every field
 * kind, the unknown-never-matches rule (missing weights, unknown spend, no
 * purchases, invited rows), the URL codec including legacy arriving links,
 * quick-set detection, and browser-local custom quick sets.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:roster-filters
 */
import assert from 'node:assert/strict';
import {
  EMPTY_DYNAMIC_OPTIONS,
  FILTER_FIELDS,
  NO_DIET_VALUE,
  dietLabel,
  activeQuickSet,
  builtInQuickSets,
  decodeCondition,
  demoStatusToRoster,
  describeCondition,
  encodeCondition,
  isCompleteCondition,
  loadCustomQuickSets,
  matchesAllConditions,
  matchesCondition,
  optionsForField,
  parseRosterView,
  programDayOn,
  pruneUnknownGroupConditions,
  removeCustomQuickSet,
  saveCustomQuickSet,
  serializeRosterView,
  type FilterCondition,
  type QuickSetStorage,
  type RosterFilterRow,
} from '../src/lib/roster-filters';

const TODAY = '2026-09-18';

const base: RosterFilterRow = {
  status: 'on_track',
  closure: null,
  programId: 'thinnr',
  stage: 'protocol',
  week: 3,
  programDay: 17,
  joinDate: '2026-08-20',
  programStartDate: '2026-09-02',
  startingWeight: 210,
  currentWeight: 198.5,
  spentCents: 61_400,
  lastPaidDate: '2026-09-10',
  activeSubscription: true,
  lastActivityDate: '2026-09-17',
  lastLogDate: '2026-09-15',
  loggingLapsed: true,
  attentionReasons: ['logging_lapsed'],
  groupIds: ['grp_mjh'],
};

const invited: RosterFilterRow = {
  status: 'invited', programId: null, stage: null, week: null, programDay: null,
  closure: null,
  joinDate: '2026-09-16', programStartDate: null, startingWeight: null, currentWeight: null,
  spentCents: 0, lastPaidDate: null, activeSubscription: false, lastActivityDate: null,
  lastLogDate: null, loggingLapsed: null, attentionReasons: [], groupIds: [],
};

const unknownSpend: RosterFilterRow = { ...base, spentCents: null, lastPaidDate: null, activeSubscription: null };

const c = (field: FilterCondition['field'], operator: FilterCondition['operator'], value: string): FilterCondition => ({ field, operator, value });
const hit = (row: RosterFilterRow, condition: FilterCondition, expected: boolean, note: string) =>
  assert.equal(matchesCondition(row, condition, TODAY), expected, note);

let passed = 0;
function section(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`ok - ${name}`);
}

section('status is / is not, active pseudo-status, invited rows', () => {
  hit(base, c('status', 'is', 'on_track'), true, 'exact status');
  hit(base, c('status', 'is_not', 'on_track'), false, 'is not own status');
  hit(base, c('status', 'is', 'active'), true, 'on_track counts as active');
  hit({ ...base, status: 'needs_attention' }, c('status', 'is', 'active'), true, 'needs_attention is still activated');
  hit({ ...base, status: 'inactive' }, c('status', 'is', 'active'), true, 'inactive is activated');
  hit({ ...base, status: 'unknown' }, c('status', 'is', 'active'), true, 'unknown activity is still an activated account');
  for (const status of ['invited', 'paused', 'discharged'] as const) {
    hit({ ...base, status }, c('status', 'is', 'active'), false, `${status} is not active`);
    hit({ ...base, status }, c('status', 'is_not', 'active'), true, `${status} is_not active`);
  }
  hit(invited, c('status', 'is', 'invited'), true, 'invited row');
  hit(invited, c('status', 'is_not', 'invited'), false, 'invited is_not invited');
  assert.equal(demoStatusToRoster('overdue'), 'needs_attention');
  assert.equal(demoStatusToRoster('graduated'), 'on_track');
  assert.equal(demoStatusToRoster('active'), 'on_track');
  assert.equal(demoStatusToRoster('paused'), 'paused');
});

section('program, stage, reason', () => {
  hit(base, c('program', 'is', 'thinnr'), true, 'program match');
  hit(base, c('program', 'is', 'glp1'), false, 'other program');
  hit(invited, c('program', 'is', 'thinnr'), false, 'no program never matches');
  hit(base, c('stage', 'is', 'week-3'), true, 'week 3');
  hit(base, c('stage', 'is', 'week-4'), false, 'week 4');
  hit(base, c('stage', 'is', 'maintenance'), false, 'protocol is not maintenance');
  hit({ ...base, stage: 'maintenance', week: null }, c('stage', 'is', 'maintenance'), true, 'maintenance');
  hit({ ...base, stage: 'maintenance', week: 6 }, c('stage', 'is', 'week-6'), false, 'maintenance ignores a stale week');
  hit(invited, c('stage', 'is', 'week-1'), false, 'no stage');
  hit(base, c('reason', 'is', 'logging_lapsed'), true, 'reason present');
  hit(base, c('reason', 'is', 'check_in_overdue'), false, 'reason absent');
});

section('numeric operators on every numeric field, missing facts never match', () => {
  const ops: Array<[FilterCondition['operator'], string, boolean]> = [
    ['lt', '18', true], ['lt', '17', false], ['lte', '17', true], ['lte', '16', false],
    ['eq', '17', true], ['eq', '16', false], ['gte', '17', true], ['gte', '18', false],
    ['gt', '16', true], ['gt', '17', false], ['between', '10..17', true], ['between', '18..30', false],
  ];
  for (const [op, value, expected] of ops) hit(base, c('program_day', op, value), expected, `program_day ${op} ${value}`);
  // Derived weights: 11.5 lb lost, 5.476…%.
  hit(base, c('weight_lost_lb', 'gte', '11.5'), true, 'lost lb gte');
  hit(base, c('weight_lost_lb', 'lt', '5'), false, 'lost less than 5 lb');
  hit(base, c('weight_lost_lb', 'eq', '11.5'), true, 'lost lb eq (decimal)');
  hit(base, c('weight_lost_pct', 'gt', '5'), true, 'lost pct gt 5');
  hit(base, c('weight_lost_pct', 'between', '5..6'), true, 'lost pct between');
  hit(base, c('current_weight', 'lte', '198.5'), true, 'current weight lte');
  hit(base, c('current_weight', 'lt', '198.5'), false, 'current weight strict lt');
  // Spend in dollars: $614.00.
  hit(base, c('spent', 'gt', '500'), true, 'spent over $500');
  hit(base, c('spent', 'between', '600..700'), true, 'spent between');
  hit(base, c('spent', 'lt', '614'), false, 'spent strict lt own value');
  hit(base, c('spent', 'lte', '614'), true, 'spent lte own value');
  // Missing facts.
  for (const field of ['program_day', 'weight_lost_lb', 'weight_lost_pct', 'current_weight'] as const) {
    hit(invited, c(field, 'lt', '1000'), false, `${field} missing never matches lt`);
    hit(invited, c(field, 'gte', '0'), false, `${field} missing never matches gte`);
  }
  hit(invited, c('spent', 'lt', '1'), true, 'no purchases with a loaded aggregate is a real $0');
  hit(invited, c('spent', 'gte', '0'), true, 'real zero matches gte 0');
  hit(unknownSpend, c('spent', 'lt', '1'), false, 'unknown spend never matches');
  hit(unknownSpend, c('spent', 'gte', '0'), false, 'unknown spend never matches gte 0');
  hit({ ...base, startingWeight: 0 }, c('weight_lost_pct', 'gte', '0'), false, 'zero starting weight has no percentage');
  // Malformed ranges match nothing (and are incomplete).
  assert.equal(isCompleteCondition(c('spent', 'between', '700..600')), false, 'inverted range incomplete');
  assert.equal(isCompleteCondition(c('spent', 'between', '600')), false, 'half range incomplete');
  assert.equal(isCompleteCondition(c('spent', 'gt', 'abc')), false, 'non-number incomplete');
  assert.equal(isCompleteCondition(c('spent', 'eq', '5')), false, '= is not offered for spend');
  hit(base, c('spent', 'gt', ''), true, 'incomplete condition matches everything');
});

section('date operators on every date field, in_last window, missing dates', () => {
  hit(base, c('join_date', 'before', '2026-08-21'), true, 'join before');
  hit(base, c('join_date', 'before', '2026-08-20'), false, 'join before is strict');
  hit(base, c('join_date', 'after', '2026-08-19'), true, 'join after');
  hit(base, c('join_date', 'after', '2026-08-20'), false, 'join after is strict');
  hit(base, c('join_date', 'between', '2026-08-01..2026-08-20'), true, 'join between inclusive end');
  hit(base, c('join_date', 'between', '2026-08-21..2026-09-01'), false, 'join outside range');
  hit(base, c('join_date', 'in_last', '29'), true, 'join in last 29 days (Aug 20 is today-29)');
  hit(base, c('join_date', 'in_last', '28'), false, 'join not in last 28 days');
  hit(base, c('program_start', 'in_last', '30'), true, 'program start recent');
  hit(base, c('last_purchase', 'after', '2026-09-01'), true, 'last purchase after');
  hit(base, c('last_purchase', 'in_last', '7'), false, 'last purchase 8 days ago');
  hit(base, c('last_purchase', 'in_last', '8'), true, 'last purchase within 8 days');
  hit(base, c('last_activity', 'in_last', '1'), true, 'active yesterday');
  hit(base, c('last_log', 'before', '2026-09-16'), true, 'last log before');
  hit({ ...base, lastLogDate: '2026-09-19' }, c('last_log', 'in_last', '3'), false, 'future-dated logs are outside the window');
  for (const field of ['program_start', 'last_purchase', 'last_activity', 'last_log'] as const) {
    hit(invited, c(field, 'before', '2099-01-01'), false, `${field} missing never matches before`);
    hit(invited, c(field, 'in_last', '3650'), false, `${field} missing never matches in_last`);
  }
  assert.equal(isCompleteCondition(c('join_date', 'before', '2026-02-31')), false, 'impossible date incomplete');
  assert.equal(isCompleteCondition(c('join_date', 'in_last', '0')), false, 'zero days incomplete');
  assert.equal(isCompleteCondition(c('join_date', 'in_last', '2.5')), false, 'fractional days incomplete');
  assert.equal(isCompleteCondition(c('last_purchase', 'between', '2026-01-01..2026-02-01')), false, 'between is not offered for last purchase');
});

section('boolean fields: yes / no, unknown never matches either', () => {
  hit(base, c('active_subscription', 'is', 'yes'), true, 'subscribed');
  hit(base, c('active_subscription', 'is', 'no'), false, 'subscribed is not no');
  hit(invited, c('active_subscription', 'is', 'no'), true, 'false matches no');
  hit(unknownSpend, c('active_subscription', 'is', 'yes'), false, 'null subscription never yes');
  hit(unknownSpend, c('active_subscription', 'is', 'no'), false, 'null subscription never no');
  hit(base, c('logging_lapsed', 'is', 'yes'), true, 'lapsed');
  hit({ ...base, loggingLapsed: false }, c('logging_lapsed', 'is', 'no'), true, 'not lapsed');
  hit(invited, c('logging_lapsed', 'is', 'yes'), false, 'unknown lapsed never yes');
  hit(invited, c('logging_lapsed', 'is', 'no'), false, 'unknown lapsed never no');
  assert.equal(isCompleteCondition(c('logging_lapsed', 'is', 'maybe')), false, 'boolean needs yes/no');
});

section('stacking is AND', () => {
  const stack = [c('spent', 'gt', '500'), c('program_day', 'gt', '50')];
  assert.equal(matchesAllConditions(base, stack, TODAY), false, 'day 17 fails the second');
  assert.equal(matchesAllConditions({ ...base, programDay: 51 }, stack, TODAY), true, 'both pass');
  assert.equal(matchesAllConditions(base, [], TODAY), true, 'empty stack matches all');
  assert.equal(matchesAllConditions(base, [c('spent', 'gt', ''), c('status', 'is', 'on_track')], TODAY), true, 'incomplete rows are skipped');
});

section('archived is sealed-only and every other view excludes sealed charts', () => {
  const sealed = { ...base, closure: { closedAt: '2026-09-01T15:00:00Z', recordRetainUntil: '2033-09-01T15:00:00Z' } };
  assert.equal(matchesAllConditions(sealed, [], TODAY), false, 'default excludes sealed rows');
  assert.equal(matchesAllConditions(sealed, [c('status', 'is', 'active')], TODAY), false, 'other views exclude sealed rows');
  assert.equal(matchesAllConditions(sealed, [c('status', 'is', 'archived')], TODAY), true, 'archived includes a sealed row');
  assert.equal(matchesAllConditions(base, [c('status', 'is', 'archived')], TODAY), false, 'archived excludes an open chart');
  assert.deepEqual(parseRosterView('?status=archived').conditions, [c('status', 'is', 'archived')]);
  assert.equal(serializeRosterView('?office=office-a', { conditions: [c('status', 'is', 'archived')], sort: { field: 'startDate', order: 'desc' } }), '?office=office-a&status=archived');
});

section('URL codec round-trips and preserves unrelated params', () => {
  const view = { conditions: [c('spent', 'gt', '500'), c('join_date', 'between', '2026-09-01..2026-09-18'), c('status', 'is_not', 'invited')], sort: { field: 'spent' as const, order: 'desc' as const } };
  const search = serializeRosterView('?attention=first&office=abc', view);
  assert.ok(search.startsWith('?'), 'query string');
  const params = new URLSearchParams(search);
  assert.equal(params.get('attention'), 'first', 'attention pin preserved');
  assert.equal(params.get('office'), 'abc', 'office preserved');
  assert.deepEqual(params.getAll('f'), ['spent:gt:500', 'join_date:between:2026-09-01..2026-09-18', 'status:is_not:invited']);
  assert.equal(params.get('sort'), 'spent.desc');
  const parsed = parseRosterView(search);
  assert.deepEqual(parsed, view, 'round trip');
  // Default sort is omitted; incomplete conditions are never written.
  assert.equal(serializeRosterView('', { conditions: [c('spent', 'gt', '')], sort: { field: 'startDate', order: 'desc' } }), '', 'nothing to write');
  // Garbage is dropped, not thrown.
  assert.deepEqual(parseRosterView('?f=nonsense&f=spent:gt:abc&f=spent:gt:5&sort=bogus.up'), { conditions: [c('spent', 'gt', '5')], sort: { field: 'startDate', order: 'desc' } });
  assert.equal(decodeCondition(encodeCondition(c('join_date', 'between', '2026-01-01..2026-02-01')))?.value, '2026-01-01..2026-02-01', 'range value keeps its dots');
});

section('legacy arriving links translate into conditions and are dropped on rewrite', () => {
  assert.deepEqual(parseRosterView('?status=active').conditions, [c('status', 'is', 'active')]);
  assert.deepEqual(parseRosterView('?status=overdue').conditions, [c('status', 'is', 'needs_attention')], 'demo overdue');
  assert.deepEqual(parseRosterView('?status=graduated').conditions, [c('stage', 'is', 'maintenance')], 'demo graduated');
  assert.deepEqual(parseRosterView('?status=bogus').conditions, [], 'unknown status ignored');
  const lapsed = parseRosterView('?logging=lapsed');
  assert.deepEqual(lapsed.conditions, [c('logging_lapsed', 'is', 'yes')]);
  assert.deepEqual(lapsed.sort, { field: 'logging', order: 'asc' }, 'lapsed arrival sorts least-engaged first');
  assert.deepEqual(parseRosterView('?logging=lapsed&sort=name.asc').sort, { field: 'name', order: 'asc' }, 'explicit sort wins');
  assert.deepEqual(parseRosterView('?reason=check_in_overdue').conditions, [c('reason', 'is', 'check_in_overdue')]);
  assert.deepEqual(parseRosterView('?reason=made_up').conditions, []);
  assert.deepEqual(parseRosterView('?subscription=active').conditions, [c('active_subscription', 'is', 'yes')]);
  assert.deepEqual(parseRosterView('?subscription=active&f=active_subscription:is:yes').conditions, [c('active_subscription', 'is', 'yes')], 'no duplicate');
  const rewritten = serializeRosterView('?status=active&logging=lapsed&reason=x&subscription=active&attention=first', parseRosterView('?status=active&attention=first'));
  const params = new URLSearchParams(rewritten);
  for (const key of ['status', 'logging', 'reason', 'subscription']) assert.equal(params.has(key), false, `${key} dropped`);
  assert.equal(params.get('attention'), 'first');
  assert.deepEqual(params.getAll('f'), ['status:is:active']);
});

section('built-in quick sets and active detection', () => {
  const sets = builtInQuickSets(TODAY);
  assert.deepEqual(sets.map((set) => set.label), ['All', 'Active', 'Needs attention', 'Inactive / lapsed', 'Invited', 'Paused', 'Archived', 'Maintenance phase', 'New this month', 'Active subscription', 'Top spenders']);
  const newThisMonth = sets.find((set) => set.id === 'new-this-month')!;
  assert.deepEqual(newThisMonth.conditions, [c('join_date', 'between', '2026-09-01..2026-09-18')]);
  assert.equal(matchesAllConditions(invited, newThisMonth.conditions, TODAY), true, 'joined Sep 16');
  assert.equal(matchesAllConditions(base, newThisMonth.conditions, TODAY), false, 'joined in August');
  const top = sets.find((set) => set.id === 'top-spenders')!;
  assert.deepEqual(top.sort, { field: 'spent', order: 'desc' });
  assert.equal(matchesAllConditions(invited, top.conditions, TODAY), false, '$0 is not a top spender');
  assert.equal(matchesAllConditions(unknownSpend, top.conditions, TODAY), false, 'unknown spend is not a top spender');
  assert.equal(activeQuickSet(sets, parseRosterView(''))?.id, 'all');
  assert.equal(activeQuickSet(sets, parseRosterView('?status=active'))?.id, 'active');
  assert.equal(activeQuickSet(sets, parseRosterView('?logging=lapsed'))?.id, 'inactive-lapsed', 'legacy lapsed link lights the quick set');
  assert.equal(activeQuickSet(sets, parseRosterView('?f=spent:gt:0'))?.id ?? null, null, 'top spenders needs its sort');
  assert.equal(activeQuickSet(sets, parseRosterView('?f=spent:gt:0&sort=spent.desc'))?.id, 'top-spenders');
  assert.equal(activeQuickSet(sets, parseRosterView('?status=active&sort=name.asc'))?.id, 'active', 'sets without a sort ignore the sort');
  assert.equal(activeQuickSet(sets, parseRosterView('?f=status:is:active&f=spent:gt:500')), null, 'a stacked view is custom');
  assert.equal(describeCondition(c('spent', 'gt', '500')), 'Total spent ($) more than $500');
  assert.equal(describeCondition(c('join_date', 'in_last', '30')), 'Join date in the last 30 days');
  assert.equal(describeCondition(c('program', 'is', 'glp1')), 'Program is GLP-1 Support');
});

section('group is / is not — dynamic options, URL, prune, chips', () => {
  const groups = [{ value: 'grp_mjh', label: 'MJH' }, { value: 'grp_tue', label: 'Tuesday clinic' }];
  const field = FILTER_FIELDS.find((definition) => definition.key === 'group')!;
  assert.equal(field.kind, 'enum');
  assert.deepEqual([...field.operators], ['is', 'is_not']);
  assert.deepEqual(optionsForField('group', EMPTY_DYNAMIC_OPTIONS), [], 'no static options');
  assert.deepEqual(optionsForField('group', { group: groups }), groups, 'options come from the office list');
  assert.deepEqual(optionsForField('status'), optionsForField('status', { group: groups }), 'static fields ignore dynamic options');

  hit(base, c('group', 'is', 'grp_mjh'), true, 'member');
  hit(base, c('group', 'is', 'grp_tue'), false, 'other group');
  hit(base, c('group', 'is_not', 'grp_tue'), true, 'is_not another group');
  hit(base, c('group', 'is_not', 'grp_mjh'), false, 'is_not own group');
  hit(invited, c('group', 'is', 'grp_mjh'), false, 'no groups never is');
  hit(invited, c('group', 'is_not', 'grp_mjh'), true, 'membership is always known: no groups is_not any group');
  hit({ ...base, groupIds: ['grp_tue', 'grp_mjh'] }, c('group', 'is', 'grp_mjh'), true, 'any of several');

  // Stacks with every other condition under AND.
  assert.equal(matchesAllConditions(base, [c('group', 'is', 'grp_mjh'), c('status', 'is', 'active'), c('spent', 'gt', '500')], TODAY), true);
  assert.equal(matchesAllConditions(base, [c('group', 'is', 'grp_mjh'), c('status', 'is', 'paused')], TODAY), false);

  // URL codec.
  assert.equal(encodeCondition(c('group', 'is', 'grp_mjh')), 'group:is:grp_mjh');
  assert.deepEqual(decodeCondition('group:is:grp_mjh'), c('group', 'is', 'grp_mjh'));
  assert.deepEqual(decodeCondition('group:is_not:grp_tue'), c('group', 'is_not', 'grp_tue'));
  assert.equal(decodeCondition('group:gt:grp_mjh'), null, 'numeric operator rejected');
  assert.equal(decodeCondition('group:is:'), null, 'empty group id rejected');
  const view = parseRosterView('?f=group:is:grp_mjh&f=status:is:active');
  assert.deepEqual(view.conditions, [c('group', 'is', 'grp_mjh'), c('status', 'is', 'active')]);
  assert.equal(serializeRosterView('', view), '?f=group%3Ais%3Agrp_mjh&f=status%3Ais%3Aactive');
  assert.equal(isCompleteCondition(c('group', 'is', 'grp_mjh')), true);
  assert.equal(isCompleteCondition(c('group', 'is', '')), false);

  // Quick sets round-trip the group condition.
  const memory = new Map<string, string>();
  const storage: QuickSetStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const saved = saveCustomQuickSet(storage, 'MJH cohort', view);
  assert.deepEqual(loadCustomQuickSets(storage)[0].conditions, view.conditions);
  assert.equal(activeQuickSet([...builtInQuickSets(TODAY), ...saved], view)?.id, saved[0].id);

  // A deleted group's condition is dropped as invalid, other conditions kept.
  const known = new Set(['grp_tue']);
  assert.deepEqual(pruneUnknownGroupConditions(view.conditions, known), [c('status', 'is', 'active')]);
  assert.deepEqual(pruneUnknownGroupConditions(view.conditions, new Set(['grp_mjh'])), view.conditions, 'known group kept');
  assert.deepEqual(pruneUnknownGroupConditions([c('spent', 'gt', '1')], new Set()), [c('spent', 'gt', '1')], 'non-group conditions untouched');

  // Chips name the group.
  assert.equal(describeCondition(c('group', 'is', 'grp_mjh'), { group: groups }), 'Group is MJH');
  assert.equal(describeCondition(c('group', 'is_not', 'grp_tue'), { group: groups }), 'Group is not Tuesday clinic');
  assert.equal(describeCondition(c('group', 'is', 'grp_gone'), { group: groups }), 'Group is a removed group');
  assert.equal(describeCondition(c('program', 'is', 'glp1'), { group: groups }), 'Program is GLP-1 Support', 'program labels still resolve');
});

section('custom quick sets persist in the given storage', () => {
  const memory = new Map<string, string>();
  const storage: QuickSetStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  assert.deepEqual(loadCustomQuickSets(storage), []);
  assert.deepEqual(loadCustomQuickSets(null), [], 'no storage → no sets');
  assert.throws(() => saveCustomQuickSet(storage, '   ', { conditions: [], sort: { field: 'name', order: 'asc' } }), /name/);
  const view = parseRosterView('?f=spent:gt:500&f=program_day:gt:50&sort=spent.desc');
  const saved = saveCustomQuickSet(storage, ' Big spenders past day 50 ', view);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].label, 'Big spenders past day 50');
  assert.equal(saved[0].builtIn, false);
  const reloaded = loadCustomQuickSets(storage);
  assert.deepEqual(reloaded[0].conditions, view.conditions, 'conditions survive reload');
  assert.deepEqual(reloaded[0].sort, view.sort, 'sort survives reload');
  assert.equal(activeQuickSet([...builtInQuickSets(TODAY), ...reloaded], view)?.id, reloaded[0].id, 'saved set lights up');
  assert.deepEqual(removeCustomQuickSet(storage, reloaded[0].id), []);
  assert.deepEqual(loadCustomQuickSets(storage), []);
  memory.set('thinnr.roster.quick-sets', '{not json');
  assert.deepEqual(loadCustomQuickSets(storage), [], 'corrupt storage reads as empty');
});

section('program day', () => {
  assert.equal(programDayOn('2026-09-18', TODAY), 1, 'start day is day 1');
  assert.equal(programDayOn('2026-09-02', TODAY), 17);
  assert.equal(programDayOn('2026-09-19', TODAY), null, 'future start');
  assert.equal(programDayOn(null, TODAY), null);
});

section('diet facts — three-way unknown, no-diet value, fits %, flags, URL round trip', () => {
  const onDiet: RosterFilterRow = { ...base, diet: { slug: 'mediterranean', pendingBlock: false, severeAllergy: true, fitsDietPct: 82 } };
  const noDiet: RosterFilterRow = { ...base, diet: { slug: null, pendingBlock: true, severeAllergy: false, fitsDietPct: null } };
  const unknownDiet: RosterFilterRow = { ...base, diet: null };
  const unreadDiet: RosterFilterRow = { ...base };
  hit(onDiet, c('diet', 'is', 'mediterranean'), true, 'diet is');
  hit(onDiet, c('diet', 'is_not', 'keto'), true, 'diet is not another');
  hit(onDiet, c('diet', 'is', NO_DIET_VALUE), false, 'on a diet is not "no diet"');
  hit(noDiet, c('diet', 'is', NO_DIET_VALUE), true, 'no diet chosen is a real fact');
  hit(noDiet, c('diet', 'is_not', 'mediterranean'), true, 'no diet is not mediterranean');
  hit(unknownDiet, c('diet', 'is', NO_DIET_VALUE), false, 'unknown family never reads as no diet');
  hit(unknownDiet, c('diet', 'is_not', 'keto'), false, 'unknown family matches no negative either');
  hit(unreadDiet, c('diet', 'is', 'mediterranean'), false, 'missing family is unknown');
  hit(onDiet, c('fits_diet', 'gte', '80'), true, 'fits % number operator');
  hit(onDiet, c('fits_diet', 'lt', '50'), false, 'fits % below');
  hit(noDiet, c('fits_diet', 'lt', '50'), false, 'null fits % is unknown, never 0');
  hit(unknownDiet, c('fits_diet', 'lte', '100'), false, 'unknown family has no fits %');
  hit(onDiet, c('severe_allergy', 'is', 'yes'), true, 'severe allergy yes');
  hit(noDiet, c('severe_allergy', 'is', 'no'), true, 'severe allergy no');
  hit(unknownDiet, c('severe_allergy', 'is', 'no'), false, 'unknown is not "no severe allergy"');
  hit(noDiet, c('pending_block', 'is', 'yes'), true, 'pending block yes');
  hit(onDiet, c('pending_block', 'is', 'no'), true, 'pending block no');
  hit(unknownDiet, c('pending_block', 'is', 'no'), false, 'unknown is not "no block"');
  const view = { conditions: [c('diet', 'is', NO_DIET_VALUE), c('fits_diet', 'gte', '75'), c('severe_allergy', 'is', 'yes'), c('pending_block', 'is', 'yes')], sort: { field: 'fitsDiet' as const, order: 'desc' as const } };
  const search = serializeRosterView('?office=abc', view);
  assert.deepEqual(new URLSearchParams(search).getAll('f'), ['diet:is:none', 'fits_diet:gte:75', 'severe_allergy:is:yes', 'pending_block:is:yes']);
  assert.equal(new URLSearchParams(search).get('sort'), 'fitsDiet.desc');
  assert.deepEqual(parseRosterView(search), view, 'diet view round trips');
  assert.equal(describeCondition(c('diet', 'is', NO_DIET_VALUE), EMPTY_DYNAMIC_OPTIONS), 'Diet is No diet chosen');
  assert.equal(describeCondition(c('diet', 'is', 'mediterranean'), { ...EMPTY_DYNAMIC_OPTIONS, diet: [{ value: 'mediterranean', label: 'Mediterranean' }] }), 'Diet is Mediterranean');
  assert.equal(dietLabel('low_fodmap'), 'Low Fodmap', 'unlisted slugs humanize');
  assert.deepEqual(optionsForField('diet', { ...EMPTY_DYNAMIC_OPTIONS, diet: [{ value: 'keto', label: 'Ketogenic' }] }).map((o) => o.value), ['keto', NO_DIET_VALUE], 'no-diet option appended');
  assert.equal(describeCondition(c('fits_diet', 'gte', '75'), EMPTY_DYNAMIC_OPTIONS), 'Fits diet (%) at least 75%');
});

console.log(`\nroster filters: ${passed} sections passed`);
