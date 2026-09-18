/**
 * Stackable roster filters: the condition model, the pure evaluator shared by
 * the live and demo rosters, the URL codec, and the quick sets.
 *
 * Free of React and browser globals (custom quick-set storage takes the
 * Storage object as an argument) so the regression scripts can exercise every
 * operator without booting the page.
 *
 * Semantics worth keeping straight:
 *  - Conditions stack with AND; an incomplete condition (no value yet) is
 *    ignored by the evaluator and never written to the URL.
 *  - A missing fact never matches: no recorded weight, no purchases loaded
 *    (spend unknown), an unknown lapsed verdict, or a null subscription flag
 *    fail every comparison, "is not" and "no" included. Unknown is not false.
 *  - A patient with no paid order but a loaded spend aggregate is a real $0.
 *  - Dates are compared as `YYYY-MM-DD` keys; "in the last N days" is the
 *    window [today - N, today]; "before"/"after" are strict.
 */
import { addDaysToKey, dateToKey, keyToDate } from './date-range-keys';

export type RosterStatus = 'on_track' | 'needs_attention' | 'inactive' | 'paused' | 'discharged' | 'invited' | 'unknown';

/** `active` is the roster's activated-account view: every status except invited, paused, and discharged. */
export type StatusFilterValue = RosterStatus | 'active';

export const ATTENTION_REASONS = ['check_in_overdue', 'logging_lapsed', 'no_activity_14d'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** Everything the evaluator needs about one roster row (live or demo). */
export interface RosterFilterRow {
  status: RosterStatus;
  programId: string | null;
  stage: 'protocol' | 'maintenance' | null;
  week: number | null;
  programDay: number | null;
  /** Account creation day (YYYY-MM-DD). */
  joinDate: string | null;
  programStartDate: string | null;
  startingWeight: number | null;
  currentWeight: number | null;
  /** Lifetime net spend in cents; null while the spend aggregate is unknown. */
  spentCents: number | null;
  lastPaidDate: string | null;
  activeSubscription: boolean | null;
  lastActivityDate: string | null;
  lastLogDate: string | null;
  /** null when the activity signals did not load (never treated as lapsed or not lapsed). */
  loggingLapsed: boolean | null;
  attentionReasons: readonly string[];
}

export type FilterField =
  | 'status' | 'program' | 'stage' | 'program_day'
  | 'join_date' | 'program_start'
  | 'weight_lost_lb' | 'weight_lost_pct' | 'current_weight'
  | 'spent' | 'last_purchase' | 'active_subscription'
  | 'last_activity' | 'last_log' | 'logging_lapsed'
  | 'reason';

export type FilterOperator =
  | 'is' | 'is_not'
  | 'lt' | 'lte' | 'eq' | 'gte' | 'gt' | 'between'
  | 'before' | 'after' | 'in_last';

export type FieldKind = 'enum' | 'number' | 'date' | 'boolean';

export interface FilterCondition {
  field: FilterField;
  operator: FilterOperator;
  /**
   * Serialized value: enum key, number, `min..max`, `YYYY-MM-DD`,
   * `from..to`, day count for `in_last`, or `yes` / `no`. Empty while the
   * builder row is still being filled in.
   */
  value: string;
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDefinition {
  key: FilterField;
  label: string;
  kind: FieldKind;
  operators: readonly FilterOperator[];
  /** Static options for enum fields (program options come from the roster). */
  options?: readonly FieldOption[];
  /** Unit shown next to numeric inputs. */
  unit?: string;
  /** Integer-only numeric input (program day, day counts). */
  integer?: boolean;
}

const NUMBER_OPERATORS = ['lt', 'lte', 'eq', 'gte', 'gt', 'between'] as const;
const DATE_OPERATORS = ['before', 'after', 'between', 'in_last'] as const;
const RECENCY_OPERATORS = ['before', 'after', 'in_last'] as const;

export const STATUS_OPTIONS: readonly FieldOption[] = [
  { value: 'active', label: 'Active (activated)' },
  { value: 'on_track', label: 'On track' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'paused', label: 'Paused' },
  { value: 'discharged', label: 'Discharged' },
  { value: 'invited', label: 'Invited' },
  { value: 'unknown', label: 'Activity unknown' },
];

export const STAGE_OPTIONS: readonly FieldOption[] = [
  ...[1, 2, 3, 4, 5, 6].map((week) => ({ value: `week-${week}`, label: `Protocol week ${week}` })),
  { value: 'maintenance', label: 'Maintenance' },
];

export const REASON_OPTIONS: readonly FieldOption[] = [
  { value: 'check_in_overdue', label: 'Check-in overdue' },
  { value: 'logging_lapsed', label: 'Logging lapsed' },
  { value: 'no_activity_14d', label: 'Inactive (14 days)' },
];

export const YES_NO_OPTIONS: readonly FieldOption[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

/** Known program ids and their display names; unknown ids are humanized. */
const PROGRAM_LABELS: Record<string, string> = {
  thinnr: 'THINNR Protocol',
  glp1: 'GLP-1 Support',
};

export function programLabel(programId: string): string {
  return PROGRAM_LABELS[programId] ?? programId.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export const FILTER_FIELDS: readonly FieldDefinition[] = [
  { key: 'status', label: 'Status', kind: 'enum', operators: ['is', 'is_not'], options: STATUS_OPTIONS },
  { key: 'program', label: 'Program', kind: 'enum', operators: ['is'] },
  { key: 'stage', label: 'Program stage', kind: 'enum', operators: ['is'], options: STAGE_OPTIONS },
  { key: 'program_day', label: 'Program day', kind: 'number', operators: NUMBER_OPERATORS, unit: 'day', integer: true },
  { key: 'join_date', label: 'Join date', kind: 'date', operators: DATE_OPERATORS },
  { key: 'program_start', label: 'Program start date', kind: 'date', operators: DATE_OPERATORS },
  { key: 'weight_lost_lb', label: 'Weight lost (lb)', kind: 'number', operators: NUMBER_OPERATORS, unit: 'lb' },
  { key: 'weight_lost_pct', label: 'Weight lost (%)', kind: 'number', operators: NUMBER_OPERATORS, unit: '%' },
  { key: 'current_weight', label: 'Current weight (lb)', kind: 'number', operators: NUMBER_OPERATORS, unit: 'lb' },
  { key: 'spent', label: 'Total spent ($)', kind: 'number', operators: ['lt', 'lte', 'gte', 'gt', 'between'], unit: '$' },
  { key: 'last_purchase', label: 'Last purchase', kind: 'date', operators: RECENCY_OPERATORS },
  { key: 'active_subscription', label: 'Active subscription', kind: 'boolean', operators: ['is'], options: YES_NO_OPTIONS },
  { key: 'last_activity', label: 'Last activity', kind: 'date', operators: RECENCY_OPERATORS },
  { key: 'last_log', label: 'Last log', kind: 'date', operators: RECENCY_OPERATORS },
  { key: 'logging_lapsed', label: 'Logging lapsed', kind: 'boolean', operators: ['is'], options: YES_NO_OPTIONS },
  { key: 'reason', label: 'Attention reason', kind: 'enum', operators: ['is'], options: REASON_OPTIONS },
];

const FIELD_BY_KEY = new Map(FILTER_FIELDS.map((field) => [field.key, field]));

export function fieldDefinition(field: FilterField): FieldDefinition {
  return FIELD_BY_KEY.get(field)!;
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: 'is',
  is_not: 'is not',
  lt: '<',
  lte: '≤',
  eq: '=',
  gte: '≥',
  gt: '>',
  between: 'between',
  before: 'before',
  after: 'after',
  in_last: 'in the last',
};

/** Spoken form for screen readers and chip text. */
export const OPERATOR_SPOKEN: Record<FilterOperator, string> = {
  is: 'is',
  is_not: 'is not',
  lt: 'less than',
  lte: 'at most',
  eq: 'exactly',
  gte: 'at least',
  gt: 'more than',
  between: 'between',
  before: 'before',
  after: 'after',
  in_last: 'in the last',
};

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function parseNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseRange(raw: string): [string, string] | null {
  const index = raw.indexOf('..');
  if (index < 0) return null;
  return [raw.slice(0, index), raw.slice(index + 2)];
}

function parseDateKey(raw: string): string | null {
  if (!DATE_KEY.test(raw)) return null;
  // Round-trip through a real Date so 2026-02-31 is rejected.
  return dateToKey(keyToDate(raw)) === raw ? raw : null;
}

/** True when the condition carries a usable value for its field and operator. */
export function isCompleteCondition(condition: FilterCondition): boolean {
  const field = FIELD_BY_KEY.get(condition.field);
  if (!field || !field.operators.includes(condition.operator)) return false;
  const { operator, value } = condition;
  if (field.kind === 'enum' || field.kind === 'boolean') {
    if (field.options) return field.options.some((option) => option.value === value);
    return value.trim().length > 0;
  }
  if (field.kind === 'number') {
    if (operator === 'between') {
      const range = parseRange(value);
      if (!range) return false;
      const min = parseNumber(range[0]);
      const max = parseNumber(range[1]);
      return min != null && max != null && min <= max;
    }
    return parseNumber(value) != null;
  }
  // date
  if (operator === 'in_last') {
    const days = parseNumber(value);
    return days != null && Number.isInteger(days) && days >= 1;
  }
  if (operator === 'between') {
    const range = parseRange(value);
    if (!range) return false;
    const from = parseDateKey(range[0]);
    const to = parseDateKey(range[1]);
    return from != null && to != null && from <= to;
  }
  return parseDateKey(value) != null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function numberFact(row: RosterFilterRow, field: FilterField): number | null {
  switch (field) {
    case 'program_day': return row.programDay;
    case 'current_weight': return row.currentWeight;
    case 'weight_lost_lb':
      return row.startingWeight != null && row.currentWeight != null ? row.startingWeight - row.currentWeight : null;
    case 'weight_lost_pct':
      return row.startingWeight != null && row.startingWeight > 0 && row.currentWeight != null
        ? ((row.startingWeight - row.currentWeight) / row.startingWeight) * 100
        : null;
    case 'spent': return row.spentCents == null ? null : row.spentCents / 100;
    default: return null;
  }
}

function dateFact(row: RosterFilterRow, field: FilterField): string | null {
  switch (field) {
    case 'join_date': return row.joinDate;
    case 'program_start': return row.programStartDate;
    case 'last_purchase': return row.lastPaidDate;
    case 'last_activity': return row.lastActivityDate;
    case 'last_log': return row.lastLogDate;
    default: return null;
  }
}

function compareNumber(actual: number, operator: FilterOperator, value: string): boolean {
  if (operator === 'between') {
    const range = parseRange(value);
    if (!range) return false;
    const min = parseNumber(range[0]);
    const max = parseNumber(range[1]);
    return min != null && max != null && actual >= min && actual <= max;
  }
  const expected = parseNumber(value);
  if (expected == null) return false;
  // Weights and dollars carry decimals; compare "=" at one-decimal precision.
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  switch (operator) {
    case 'lt': return actual < expected && !near(actual, expected);
    case 'lte': return actual <= expected || near(actual, expected);
    case 'eq': return near(actual, expected);
    case 'gte': return actual >= expected || near(actual, expected);
    case 'gt': return actual > expected && !near(actual, expected);
    default: return false;
  }
}

function compareDate(actual: string, operator: FilterOperator, value: string, today: string): boolean {
  switch (operator) {
    case 'before': return parseDateKey(value) != null && actual < value;
    case 'after': return parseDateKey(value) != null && actual > value;
    case 'between': {
      const range = parseRange(value);
      if (!range || parseDateKey(range[0]) == null || parseDateKey(range[1]) == null) return false;
      return actual >= range[0] && actual <= range[1];
    }
    case 'in_last': {
      const days = parseNumber(value);
      if (days == null || days < 1) return false;
      return actual >= addDaysToKey(today, -Math.floor(days)) && actual <= today;
    }
    default: return false;
  }
}

export function isActivatedStatus(status: RosterStatus): boolean {
  return status !== 'invited' && status !== 'paused' && status !== 'discharged';
}

function statusMatches(status: RosterStatus, value: string): boolean {
  return value === 'active' ? isActivatedStatus(status) : status === value;
}

/**
 * One condition against one row on the given day (`today` is the office's
 * current date key: the device-local day for live rosters, the fixed anchor
 * for demo personas). Incomplete conditions match everything.
 */
export function matchesCondition(row: RosterFilterRow, condition: FilterCondition, today: string): boolean {
  if (!isCompleteCondition(condition)) return true;
  const { field, operator, value } = condition;
  switch (field) {
    case 'status': {
      const hit = statusMatches(row.status, value);
      return operator === 'is_not' ? !hit : hit;
    }
    case 'program':
      return row.programId != null && row.programId === value;
    case 'stage': {
      if (value === 'maintenance') return row.stage === 'maintenance';
      const week = Number(value.replace('week-', ''));
      return row.stage === 'protocol' && row.week === week;
    }
    case 'reason':
      return row.attentionReasons.includes(value);
    case 'active_subscription':
      return row.activeSubscription != null && row.activeSubscription === (value === 'yes');
    case 'logging_lapsed':
      return row.loggingLapsed != null && row.loggingLapsed === (value === 'yes');
    case 'program_day':
    case 'weight_lost_lb':
    case 'weight_lost_pct':
    case 'current_weight':
    case 'spent': {
      const actual = numberFact(row, field);
      return actual != null && compareNumber(actual, operator, value);
    }
    case 'join_date':
    case 'program_start':
    case 'last_purchase':
    case 'last_activity':
    case 'last_log': {
      const actual = dateFact(row, field);
      return actual != null && compareDate(actual, operator, value, today);
    }
    default:
      return false;
  }
}

/** AND over every complete condition. */
export function matchesAllConditions(row: RosterFilterRow, conditions: readonly FilterCondition[], today: string): boolean {
  return conditions.every((condition) => matchesCondition(row, condition, today));
}

export function completeConditions(conditions: readonly FilterCondition[]): FilterCondition[] {
  return conditions.filter(isCompleteCondition);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function formatDateKey(key: string): string {
  return keyToDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatNumber(raw: string, field: FieldDefinition): string {
  const value = parseNumber(raw);
  if (value == null) return raw;
  const text = field.integer ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  if (field.unit === '$') return `$${text}`;
  if (field.unit === '%') return `${text}%`;
  if (field.unit === 'lb') return `${text} lb`;
  return text;
}

/** Human text for the value part of a chip, e.g. "$500", "Sep 1, 2026 – Sep 18, 2026", "30 days". */
export function describeConditionValue(condition: FilterCondition, programOptions: readonly FieldOption[] = []): string {
  const field = fieldDefinition(condition.field);
  const { operator, value } = condition;
  if (field.kind === 'enum' || field.kind === 'boolean') {
    const options = condition.field === 'program' ? programOptions : field.options ?? [];
    return options.find((option) => option.value === value)?.label ?? (condition.field === 'program' ? programLabel(value) : value);
  }
  if (operator === 'in_last') {
    const days = parseNumber(value);
    return days == null ? value : `${days} day${days === 1 ? '' : 's'}`;
  }
  if (operator === 'between') {
    const range = parseRange(value);
    if (!range) return value;
    return field.kind === 'date'
      ? `${formatDateKey(range[0])} – ${formatDateKey(range[1])}`
      : `${formatNumber(range[0], field)} and ${formatNumber(range[1], field)}`;
  }
  return field.kind === 'date' ? formatDateKey(value) : formatNumber(value, field);
}

/** Full sentence for one chip: "Total spent more than $500". */
export function describeCondition(condition: FilterCondition, programOptions: readonly FieldOption[] = []): string {
  const field = fieldDefinition(condition.field);
  return `${field.label} ${OPERATOR_SPOKEN[condition.operator]} ${describeConditionValue(condition, programOptions)}`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type RosterSortField = 'name' | 'startDate' | 'status' | 'weightLoss' | 'logging' | 'spent';
export type RosterSortOrder = 'asc' | 'desc';

export interface RosterSort {
  field: RosterSortField;
  order: RosterSortOrder;
}

export const DEFAULT_ROSTER_SORT: RosterSort = { field: 'startDate', order: 'desc' };

const SORT_FIELDS: readonly RosterSortField[] = ['name', 'startDate', 'status', 'weightLoss', 'logging', 'spent'];

export function sameSort(a: RosterSort, b: RosterSort): boolean {
  return a.field === b.field && a.order === b.order;
}

// ---------------------------------------------------------------------------
// URL codec
// ---------------------------------------------------------------------------

export const FILTER_PARAM = 'f';
export const SORT_PARAM = 'sort';
/** Arriving-link parameters older links still carry; translated on parse, dropped on write. */
const LEGACY_PARAMS = ['status', 'logging', 'reason', 'subscription'] as const;

export interface RosterView {
  conditions: FilterCondition[];
  sort: RosterSort;
}

export function encodeCondition(condition: FilterCondition): string {
  return `${condition.field}:${condition.operator}:${condition.value}`;
}

export function decodeCondition(raw: string): FilterCondition | null {
  const first = raw.indexOf(':');
  const second = first < 0 ? -1 : raw.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  const condition: FilterCondition = {
    field: raw.slice(0, first) as FilterField,
    operator: raw.slice(first + 1, second) as FilterOperator,
    value: raw.slice(second + 1),
  };
  return isCompleteCondition(condition) ? condition : null;
}

function legacyConditions(params: URLSearchParams): { conditions: FilterCondition[]; sort: RosterSort | null } {
  const conditions: FilterCondition[] = [];
  let sort: RosterSort | null = null;
  const status = params.get('status');
  if (status) {
    // Demo-era vocabulary: overdue was the seeded "needs attention", graduated
    // the maintenance stage.
    const mapped = status === 'overdue' ? 'needs_attention' : status;
    if (mapped === 'graduated') conditions.push({ field: 'stage', operator: 'is', value: 'maintenance' });
    else if (STATUS_OPTIONS.some((option) => option.value === mapped)) conditions.push({ field: 'status', operator: 'is', value: mapped });
  }
  if (params.get('logging') === 'lapsed') {
    conditions.push({ field: 'logging_lapsed', operator: 'is', value: 'yes' });
    // The overview's compliance card lands on the least-engaged first.
    sort = { field: 'logging', order: 'asc' };
  }
  const reason = params.get('reason');
  if (reason && (ATTENTION_REASONS as readonly string[]).includes(reason)) {
    conditions.push({ field: 'reason', operator: 'is', value: reason });
  }
  if (params.get('subscription') === 'active') {
    conditions.push({ field: 'active_subscription', operator: 'is', value: 'yes' });
  }
  return { conditions, sort };
}

/** Read the filters and sort out of a query string (legacy arriving links included). */
export function parseRosterView(search: string): RosterView {
  const params = new URLSearchParams(search);
  const conditions = params.getAll(FILTER_PARAM).map(decodeCondition).filter((item): item is FilterCondition => item != null);
  const legacy = legacyConditions(params);
  for (const condition of legacy.conditions) {
    if (!conditions.some((existing) => encodeCondition(existing) === encodeCondition(condition))) conditions.push(condition);
  }
  const rawSort = params.get(SORT_PARAM);
  const sort = (rawSort ? parseSort(rawSort) : null) ?? legacy.sort ?? DEFAULT_ROSTER_SORT;
  return { conditions, sort };
}

export function encodeSort(sort: RosterSort): string {
  return `${sort.field}.${sort.order}`;
}

export function parseSort(raw: string): RosterSort | null {
  const [field, order] = raw.split('.');
  if ((SORT_FIELDS as readonly string[]).includes(field) && (order === 'asc' || order === 'desc')) {
    return { field: field as RosterSortField, order };
  }
  return null;
}

/**
 * Write the view back into a query string, preserving unrelated parameters
 * (the attention-first pin, HQ scope) and dropping the legacy arriving keys
 * now expressed as conditions. Returns '' or '?…'.
 */
export function serializeRosterView(search: string, view: RosterView): string {
  const params = new URLSearchParams(search);
  params.delete(FILTER_PARAM);
  params.delete(SORT_PARAM);
  for (const key of LEGACY_PARAMS) params.delete(key);
  for (const condition of completeConditions(view.conditions)) params.append(FILTER_PARAM, encodeCondition(condition));
  if (!sameSort(view.sort, DEFAULT_ROSTER_SORT)) params.set(SORT_PARAM, encodeSort(view.sort));
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

// ---------------------------------------------------------------------------
// Quick sets
// ---------------------------------------------------------------------------

export interface QuickSet {
  id: string;
  label: string;
  conditions: FilterCondition[];
  /** Sort the set applies; sets without one keep whatever sort is active. */
  sort?: RosterSort;
  builtIn: boolean;
}

/** The built-in one-tap views; date-relative sets are computed for the office's current day. */
export function builtInQuickSets(today: string): QuickSet[] {
  const monthStart = `${today.slice(0, 7)}-01`;
  return [
    { id: 'all', label: 'All', conditions: [], builtIn: true },
    { id: 'active', label: 'Active', conditions: [{ field: 'status', operator: 'is', value: 'active' }], builtIn: true },
    { id: 'needs-attention', label: 'Needs attention', conditions: [{ field: 'status', operator: 'is', value: 'needs_attention' }], builtIn: true },
    { id: 'inactive-lapsed', label: 'Inactive / lapsed', conditions: [{ field: 'logging_lapsed', operator: 'is', value: 'yes' }], sort: { field: 'logging', order: 'asc' }, builtIn: true },
    { id: 'invited', label: 'Invited', conditions: [{ field: 'status', operator: 'is', value: 'invited' }], builtIn: true },
    { id: 'paused', label: 'Paused', conditions: [{ field: 'status', operator: 'is', value: 'paused' }], builtIn: true },
    { id: 'maintenance', label: 'Maintenance phase', conditions: [{ field: 'stage', operator: 'is', value: 'maintenance' }], builtIn: true },
    { id: 'new-this-month', label: 'New this month', conditions: [{ field: 'join_date', operator: 'between', value: `${monthStart}..${today}` }], builtIn: true },
    { id: 'active-subscription', label: 'Active subscription', conditions: [{ field: 'active_subscription', operator: 'is', value: 'yes' }], builtIn: true },
    { id: 'top-spenders', label: 'Top spenders', conditions: [{ field: 'spent', operator: 'gt', value: '0' }], sort: { field: 'spent', order: 'desc' }, builtIn: true },
  ];
}

function conditionSignature(conditions: readonly FilterCondition[]): string {
  return completeConditions(conditions).map(encodeCondition).sort().join('&');
}

/** The quick set whose stack (and sort, when it has one) is exactly the current view; null when the view is custom. */
export function activeQuickSet(sets: readonly QuickSet[], view: RosterView): QuickSet | null {
  const signature = conditionSignature(view.conditions);
  return sets.find((set) => conditionSignature(set.conditions) === signature && (!set.sort || sameSort(set.sort, view.sort))) ?? null;
}

export const CUSTOM_QUICK_SETS_KEY = 'thinnr.roster.quick-sets';

interface StoredQuickSet {
  id: string;
  label: string;
  conditions: string[];
  sort?: string;
}

/** Storage subset used here (localStorage in the browser, a Map-backed fake in tests). */
export interface QuickSetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadCustomQuickSets(storage: QuickSetStorage | null | undefined): QuickSet[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOM_QUICK_SETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const sets: QuickSet[] = [];
    for (const item of parsed as StoredQuickSet[]) {
      if (!item || typeof item.id !== 'string' || typeof item.label !== 'string' || !Array.isArray(item.conditions)) continue;
      const conditions = item.conditions.map((entry) => (typeof entry === 'string' ? decodeCondition(entry) : null)).filter((entry): entry is FilterCondition => entry != null);
      const sort = typeof item.sort === 'string' ? parseSort(item.sort) ?? undefined : undefined;
      sets.push({ id: item.id, label: item.label, conditions, sort, builtIn: false });
    }
    return sets;
  } catch {
    return [];
  }
}

function persist(storage: QuickSetStorage, sets: readonly QuickSet[]): void {
  const stored: StoredQuickSet[] = sets.map((set) => ({
    id: set.id,
    label: set.label,
    conditions: completeConditions(set.conditions).map(encodeCondition),
    ...(set.sort ? { sort: encodeSort(set.sort) } : {}),
  }));
  storage.setItem(CUSTOM_QUICK_SETS_KEY, JSON.stringify(stored));
}

/** Save the current stack under a name; returns the new list. Names are trimmed; blank names are rejected. */
export function saveCustomQuickSet(storage: QuickSetStorage, name: string, view: RosterView): QuickSet[] {
  const label = name.trim();
  if (!label) throw new Error('Give the quick set a name.');
  const existing = loadCustomQuickSets(storage);
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const next = [...existing, { id, label, conditions: completeConditions(view.conditions), sort: view.sort, builtIn: false }];
  persist(storage, next);
  return next;
}

export function removeCustomQuickSet(storage: QuickSetStorage, id: string): QuickSet[] {
  const next = loadCustomQuickSets(storage).filter((set) => set.id !== id);
  persist(storage, next);
  return next;
}

// ---------------------------------------------------------------------------
// Row helpers shared by the live and demo mappers
// ---------------------------------------------------------------------------

const ROSTER_STATUSES: readonly RosterStatus[] = ['on_track', 'needs_attention', 'inactive', 'paused', 'discharged', 'invited', 'unknown'];

/** Live operational status, or `unknown` for anything unexpected. */
export function toRosterStatus(status: string | null | undefined): RosterStatus {
  return (ROSTER_STATUSES as readonly string[]).includes(status ?? '') ? (status as RosterStatus) : 'unknown';
}

/** Demo roster vocabulary → the live one (graduated rows are on track in maintenance). */
export function demoStatusToRoster(status: string): RosterStatus {
  switch (status) {
    case 'active':
    case 'graduated':
      return 'on_track';
    case 'overdue':
      return 'needs_attention';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'discharged';
    default:
      return 'unknown';
  }
}

/** `YYYY-MM-DD` of an ISO timestamp in the device's timezone (null for blanks / garbage). */
export function dateKeyOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (DATE_KEY.test(iso)) return iso;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateToKey(date);
}

/** Inclusive day count from a start key to today (day 1 = the start day); null before the start. */
export function programDayOn(startKey: string | null, today: string): number | null {
  if (!startKey) return null;
  const days = Math.round((keyToDate(today).getTime() - keyToDate(startKey).getTime()) / 86_400_000) + 1;
  return days >= 1 ? days : null;
}
