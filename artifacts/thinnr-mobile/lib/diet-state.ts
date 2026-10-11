/**
 * The patient's diet slice as the app holds it: the GET /patient-data/diet
 * answer (selection, phase, preferences, screening, activity) plus the
 * targets answer, with pure helpers every diet surface shares —
 *
 *  - wire parsing (never trust the shape blindly),
 *  - queue projection, so a queued list edit shows up immediately and reads
 *    back identically once it lands,
 *  - the eating-window clock and the Whole30 day counter,
 *  - the classifier context a food badge needs.
 *
 * Nothing here touches the network or React.
 */
import type { QueuedWrite } from '@/lib/patient-write-queue';
import { DIET_BY_SLUG, JUST_TRACKING_SLUG, derivePhase, type PhaseState, type PreferenceItemInput } from '@/lib/diet-fit';
import type { ActivityLevel, ActivitySource, ClassifierContext, PreferenceList, ScreeningAnswer, ScreeningQuestion } from '@/lib/diet-fit';

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type AllergySeverity = 'mild' | 'severe';

export interface DietPreference {
  id: string;
  list: PreferenceList;
  key: string;
  label: string;
  isCustom: boolean;
  severity: AllergySeverity | null;
  enteredByRole: string;
  enteredByName: string | null;
  createdAt: string;
}

export interface FastingWindow {
  /** HH:MM local clock time the eating window opens. */
  eatingStart: string;
  /** HH:MM local clock time the eating window closes. */
  eatingEnd: string;
}

export interface DietSettings {
  fastingWindow?: FastingWindow | null;
  whole30StartDate?: string | null;
}

export interface DietSelection {
  id: string;
  dietSlug: string;
  status: string;
  selectedByRole: string;
  settings: DietSettings;
  startedAt: string;
  endedAt: string | null;
}

export interface DietBlock {
  id: string;
  selectionId: string | null;
  dietSlug: string;
  questions: ScreeningQuestion[];
  status: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface DietPhase extends PhaseState {
  episodeId: string | null;
  episodeNumber: number | null;
  episodeStartedOn: string | null;
}

export type ScreeningAnswers = Partial<Record<ScreeningQuestion, ScreeningAnswer>>;

export interface DietActivity {
  level: ActivityLevel;
  source: ActivitySource;
  recordedOn: string;
}

export interface DietState {
  dateKey: string;
  programId: 'thinnr' | 'glp1' | 'none' | null;
  phase: DietPhase;
  currentDiet: DietSelection | null;
  /** The diet in force for food badges: null while the protocol locks the picker. */
  effectiveDietSlug: string | null;
  pendingSelection: DietSelection | null;
  pendingBlock: DietBlock | null;
  suggestedDefaultSlug: string;
  screening: { answers: ScreeningAnswers; pregnancyConflict: boolean };
  preferences: DietPreference[];
  activityLevel: DietActivity | null;
}

export interface TargetNumbers {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterOz: number;
}

export type TargetOverrideWrite = Partial<Record<keyof TargetNumbers, number | null>>;

export interface DietTargetsState {
  dateKey: string;
  calculated: TargetNumbers;
  effective: TargetNumbers;
  overrides: Record<keyof TargetNumbers, number | null>;
  overridden: Array<keyof TargetNumbers>;
  missing: string[];
  activityLevel: ActivityLevel | null;
}

/** Queue payloads the diet slice owns (declared here, re-exported by the queue). */
export type DietQueuedWrite =
  | {
      kind: 'dietSelection';
      dietSlug: string;
      answers?: ScreeningAnswers;
      settings?: DietSettings;
      activityLevel?: ActivityLevel | null;
    }
  | { kind: 'dietPreferenceAdd'; item: DietPreference }
  | { kind: 'dietPreferenceSeverity'; id: string; severity: AllergySeverity }
  | { kind: 'dietPreferenceRemove'; id: string }
  | { kind: 'dietActivity'; level: ActivityLevel; source: ActivitySource; recordedOn: string }
  | { kind: 'dietScreening'; answers: ScreeningAnswers }
  | { kind: 'dietSettings'; settings: DietSettings }
  | { kind: 'dietTargets'; overrides: TargetOverrideWrite };

export const DIET_WRITE_KINDS = [
  'dietSelection',
  'dietPreferenceAdd',
  'dietPreferenceSeverity',
  'dietPreferenceRemove',
  'dietActivity',
  'dietScreening',
  'dietSettings',
  'dietTargets',
] as const;

export function isDietWrite(payload: { kind: string }): payload is DietQueuedWrite {
  return (DIET_WRITE_KINDS as readonly string[]).includes(payload.kind);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

const PREFERENCE_LISTS = new Set(['allergy', 'sensitivity', 'restriction', 'dislike']);
const SCREENING_QUESTIONS = new Set(['medication', 'eating_disorder', 'pregnancy']);
const ACTIVITY_LEVELS = new Set(['sedentary', 'light', 'moderate', 'active', 'very_active']);
const ACTIVITY_SOURCES = new Set(['diet_selection', 'check_in', 'settings', 'staff']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class DietParseError extends Error {
  constructor(message = 'The server sent an unexpected eating-plan answer.') {
    super(message);
    this.name = 'DietParseError';
  }
}

function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DietParseError();
  return raw as Record<string, unknown>;
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new DietParseError();
  return value;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DietParseError();
  return value;
}

export function parseDietSettings(raw: unknown): DietSettings {
  if (raw === null || raw === undefined) return {};
  const s = obj(raw);
  const out: DietSettings = {};
  if (s.fastingWindow === null) out.fastingWindow = null;
  else if (s.fastingWindow !== undefined) {
    const fw = obj(s.fastingWindow);
    const eatingStart = str(fw.eatingStart);
    const eatingEnd = str(fw.eatingEnd);
    if (!TIME_RE.test(eatingStart) || !TIME_RE.test(eatingEnd)) throw new DietParseError();
    out.fastingWindow = { eatingStart, eatingEnd };
  }
  if (s.whole30StartDate === null) out.whole30StartDate = null;
  else if (typeof s.whole30StartDate === 'string') out.whole30StartDate = s.whole30StartDate;
  return out;
}

export function parseDietPreference(raw: unknown): DietPreference {
  const p = obj(raw);
  const list = str(p.list);
  if (!PREFERENCE_LISTS.has(list)) throw new DietParseError();
  return {
    id: str(p.id),
    list: list as PreferenceList,
    key: str(p.key),
    label: str(p.label),
    isCustom: p.isCustom === true,
    severity: p.severity === 'mild' || p.severity === 'severe' ? p.severity : null,
    enteredByRole: typeof p.enteredByRole === 'string' ? p.enteredByRole : 'patient',
    enteredByName: strOrNull(p.enteredByName),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
  };
}

export function parseDietSelection(raw: unknown): DietSelection | null {
  if (raw === null || raw === undefined) return null;
  const s = obj(raw);
  return {
    id: str(s.id),
    dietSlug: str(s.dietSlug),
    status: typeof s.status === 'string' ? s.status : 'active',
    selectedByRole: typeof s.selectedByRole === 'string' ? s.selectedByRole : 'patient',
    settings: parseDietSettings(s.settings),
    startedAt: typeof s.startedAt === 'string' ? s.startedAt : '',
    endedAt: strOrNull(s.endedAt),
  };
}

function parseBlock(raw: unknown): DietBlock | null {
  if (raw === null || raw === undefined) return null;
  const b = obj(raw);
  return {
    id: str(b.id),
    selectionId: strOrNull(b.selectionId),
    dietSlug: str(b.dietSlug),
    questions: Array.isArray(b.questions)
      ? b.questions.filter((q): q is ScreeningQuestion => typeof q === 'string' && SCREENING_QUESTIONS.has(q))
      : [],
    status: typeof b.status === 'string' ? b.status : 'pending',
    reviewedByName: strOrNull(b.reviewedByName),
    reviewedAt: strOrNull(b.reviewedAt),
    reviewNote: strOrNull(b.reviewNote),
    createdAt: typeof b.createdAt === 'string' ? b.createdAt : '',
  };
}

export function parseScreeningAnswers(raw: unknown): ScreeningAnswers {
  if (raw === null || raw === undefined) return {};
  const a = obj(raw);
  const out: ScreeningAnswers = {};
  for (const [question, answer] of Object.entries(a)) {
    if (!SCREENING_QUESTIONS.has(question)) continue;
    if (answer === 'yes' || answer === 'no' || answer === 'skipped') out[question as ScreeningQuestion] = answer;
  }
  return out;
}

export function parseDietActivity(raw: unknown): DietActivity | null {
  if (raw === null || raw === undefined) return null;
  const a = obj(raw);
  const level = str(a.level);
  if (!ACTIVITY_LEVELS.has(level)) throw new DietParseError();
  const source = typeof a.source === 'string' && ACTIVITY_SOURCES.has(a.source) ? a.source : 'settings';
  return { level: level as ActivityLevel, source: source as ActivitySource, recordedOn: typeof a.recordedOn === 'string' ? a.recordedOn : '' };
}

export function parseDietState(raw: unknown): DietState {
  const d = obj(raw);
  const ph = obj(d.phase);
  const phase = ph.phase === 'protocol' || ph.phase === 'maintenance' ? ph.phase : null;
  if (!phase) throw new DietParseError();
  const programId = d.programId === 'thinnr' || d.programId === 'glp1' || d.programId === 'none' ? d.programId : null;
  const screening = d.screening === undefined ? {} : obj(d.screening);
  return {
    dateKey: str(d.dateKey),
    programId,
    phase: {
      programDay: num(ph.programDay),
      phase,
      phaseName: typeof ph.phaseName === 'string' ? ph.phaseName : phase === 'protocol' ? 'Protocol' : 'Maintenance',
      maintenanceDay: num(ph.maintenanceDay),
      dietPickerLocked: ph.dietPickerLocked === true,
      episodeId: strOrNull(ph.episodeId),
      episodeNumber: typeof ph.episodeNumber === 'number' ? ph.episodeNumber : null,
      episodeStartedOn: strOrNull(ph.episodeStartedOn),
    },
    currentDiet: parseDietSelection(d.currentDiet),
    effectiveDietSlug: strOrNull(d.effectiveDietSlug),
    pendingSelection: parseDietSelection(d.pendingSelection),
    pendingBlock: parseBlock(d.pendingBlock),
    suggestedDefaultSlug: typeof d.suggestedDefaultSlug === 'string' ? d.suggestedDefaultSlug : JUST_TRACKING_SLUG,
    screening: {
      answers: parseScreeningAnswers(screening.answers),
      pregnancyConflict: screening.pregnancyConflict === true,
    },
    preferences: Array.isArray(d.preferences) ? d.preferences.map(parseDietPreference) : [],
    activityLevel: parseDietActivity(d.activityLevel),
  };
}

function parseNumbers(raw: unknown): TargetNumbers {
  const t = obj(raw);
  return { calories: num(t.calories), protein: num(t.protein), carbs: num(t.carbs), fat: num(t.fat), waterOz: num(t.waterOz) };
}

export function parseDietTargets(raw: unknown): DietTargetsState {
  const t = obj(raw);
  const o = t.overrides === undefined || t.overrides === null ? {} : obj(t.overrides);
  const override = (key: keyof TargetNumbers): number | null =>
    typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : null;
  const overrides = {
    calories: override('calories'),
    protein: override('protein'),
    carbs: override('carbs'),
    fat: override('fat'),
    waterOz: override('waterOz'),
  };
  return {
    dateKey: str(t.dateKey),
    calculated: parseNumbers(t.calculated),
    effective: parseNumbers(t.effective),
    overrides,
    overridden: Array.isArray(t.overridden)
      ? t.overridden.filter((k): k is keyof TargetNumbers => typeof k === 'string' && k in overrides)
      : (Object.keys(overrides) as Array<keyof TargetNumbers>).filter(k => overrides[k] !== null),
    missing: Array.isArray(t.missing) ? t.missing.filter((m): m is string => typeof m === 'string') : [],
    activityLevel: typeof t.activityLevel === 'string' && ACTIVITY_LEVELS.has(t.activityLevel) ? (t.activityLevel as ActivityLevel) : null,
  };
}

// ─── Queue projection ───────────────────────────────────────────────────────

/** A preference added offline carries a local id until the server mints one. */
export const LOCAL_PREFERENCE_PREFIX = 'local:';
export function isLocalPreferenceId(id: string): boolean {
  return id.startsWith(LOCAL_PREFERENCE_PREFIX);
}

export function projectDietWrite(base: DietState | null, write: DietQueuedWrite): DietState | null {
  if (!base) return base;
  switch (write.kind) {
    case 'dietSelection': {
      const locked = base.phase.dietPickerLocked;
      const previous = base.currentDiet;
      const selection: DietSelection = {
        id: previous && previous.dietSlug === write.dietSlug ? previous.id : `${LOCAL_PREFERENCE_PREFIX}selection:${write.dietSlug}`,
        dietSlug: write.dietSlug,
        status: 'active',
        selectedByRole: 'patient',
        settings: write.settings ?? {},
        startedAt: previous && previous.dietSlug === write.dietSlug ? previous.startedAt : '',
        endedAt: null,
      };
      return {
        ...base,
        currentDiet: locked ? previous : selection,
        effectiveDietSlug: locked ? null : write.dietSlug,
        screening: { ...base.screening, answers: { ...base.screening.answers, ...(write.answers ?? {}) } },
        activityLevel:
          write.activityLevel && write.activityLevel !== base.activityLevel?.level
            ? { level: write.activityLevel, source: 'diet_selection', recordedOn: base.dateKey }
            : write.activityLevel
              ? base.activityLevel
              : base.activityLevel,
      };
    }
    case 'dietPreferenceAdd': {
      const duplicate = base.preferences.some(p => p.list === write.item.list && p.key === write.item.key);
      return duplicate ? base : { ...base, preferences: [...base.preferences, write.item] };
    }
    case 'dietPreferenceSeverity':
      return {
        ...base,
        preferences: base.preferences.map(p => (p.id === write.id ? { ...p, severity: write.severity } : p)),
      };
    case 'dietPreferenceRemove':
      return { ...base, preferences: base.preferences.filter(p => p.id !== write.id) };
    case 'dietActivity':
      return { ...base, activityLevel: { level: write.level, source: write.source, recordedOn: write.recordedOn } };
    case 'dietScreening':
      return { ...base, screening: { ...base.screening, answers: { ...base.screening.answers, ...write.answers } } };
    case 'dietSettings':
      if (!base.currentDiet) return base;
      return { ...base, currentDiet: { ...base.currentDiet, settings: { ...base.currentDiet.settings, ...write.settings } } };
    case 'dietTargets':
      return base;
  }
}

export function projectDietQueue(base: DietState | null, queue: readonly QueuedWrite[]): DietState | null {
  let state = base;
  for (const item of queue) {
    if (isDietWrite(item.payload)) state = projectDietWrite(state, item.payload);
  }
  return state;
}

export function projectTargetsQueue(base: DietTargetsState | null, queue: readonly QueuedWrite[]): DietTargetsState | null {
  if (!base) return base;
  let overrides = { ...base.overrides };
  let touched = false;
  for (const item of queue) {
    if (item.payload.kind !== 'dietTargets') continue;
    touched = true;
    for (const [key, value] of Object.entries(item.payload.overrides)) {
      if (value === undefined) continue;
      overrides = { ...overrides, [key]: value };
    }
  }
  if (!touched) return base;
  const keys = Object.keys(overrides) as Array<keyof TargetNumbers>;
  const effective = { ...base.calculated };
  const overridden: Array<keyof TargetNumbers> = [];
  for (const key of keys) {
    const value = overrides[key];
    if (value !== null) {
      effective[key] = value;
      overridden.push(key);
    }
  }
  return { ...base, overrides, effective, overridden };
}

// ─── Classifier context ─────────────────────────────────────────────────────

export function preferenceInputs(preferences: readonly DietPreference[]): PreferenceItemInput[] {
  return preferences.map(p => ({
    list: p.list,
    key: p.key,
    label: p.label,
    ...(p.isCustom ? { custom: true } : {}),
    ...(p.severity ? { severity: p.severity } : {}),
  }));
}

/** The classifier context for the diet in force (protocol → Approved Foods decides). */
export function fitContextFor(diet: DietState | null): ClassifierContext | null {
  if (!diet) return null;
  return {
    dietSlug: diet.phase.phase === 'protocol' ? null : diet.effectiveDietSlug,
    phase: diet.phase.phase,
    preferences: preferenceInputs(diet.preferences),
  };
}

// ─── Fasting window & Whole30 ───────────────────────────────────────────────

export interface FastingPreset {
  id: string;
  label: string;
  /** Hours the eating window stays open. */
  eatingHours: number;
  defaultStart: string;
}

export const FASTING_PRESETS: readonly FastingPreset[] = [
  { id: '16:8', label: '16:8', eatingHours: 8, defaultStart: '12:00' },
  { id: '18:6', label: '18:6', eatingHours: 6, defaultStart: '12:00' },
  { id: '14:10', label: '14:10', eatingHours: 10, defaultStart: '10:00' },
  { id: '20:4', label: '20:4', eatingHours: 4, defaultStart: '14:00' },
];

export const WHOLE30_LENGTH_DAYS = 30;

export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function timeOfMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function fastingWindowFor(preset: FastingPreset, eatingStart: string): FastingWindow {
  return { eatingStart, eatingEnd: timeOfMinutes(minutesOf(eatingStart) + preset.eatingHours * 60) };
}

/** Which preset a stored window matches (by eating-hours), if any. */
export function presetForWindow(window: FastingWindow | null | undefined): FastingPreset | null {
  if (!window) return null;
  const length = ((minutesOf(window.eatingEnd) - minutesOf(window.eatingStart)) % 1440 + 1440) % 1440;
  return FASTING_PRESETS.find(p => p.eatingHours * 60 === length) ?? null;
}

export function formatClock(time: string): string {
  const total = minutesOf(time);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export interface EatingWindowStatus {
  /** True while the eating window is open. */
  eating: boolean;
  /** Minutes until the window flips (opens or closes). */
  minutesRemaining: number;
  /** Clock time of that flip. */
  nextChangeAt: string;
}

/** Where "now" (minutes since local midnight) sits relative to the eating window. */
export function eatingWindowStatus(window: FastingWindow, nowMinutes: number): EatingWindowStatus {
  const start = minutesOf(window.eatingStart);
  const length = ((minutesOf(window.eatingEnd) - start) % 1440 + 1440) % 1440 || 1440;
  const sinceStart = ((nowMinutes - start) % 1440 + 1440) % 1440;
  if (sinceStart < length) {
    return { eating: true, minutesRemaining: length - sinceStart, nextChangeAt: window.eatingEnd };
  }
  return { eating: false, minutesRemaining: 1440 - sinceStart, nextChangeAt: window.eatingStart };
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

export interface Whole30Status {
  /** 1-based day in the 30; > 30 once finished. */
  day: number;
  finished: boolean;
  daysLeft: number;
}

export function whole30Status(startDate: string, todayKey: string): Whole30Status {
  const start = Date.UTC(Number(startDate.slice(0, 4)), Number(startDate.slice(5, 7)) - 1, Number(startDate.slice(8, 10)));
  const today = Date.UTC(Number(todayKey.slice(0, 4)), Number(todayKey.slice(5, 7)) - 1, Number(todayKey.slice(8, 10)));
  const day = Math.floor((today - start) / 86_400_000) + 1;
  return { day, finished: day > WHOLE30_LENGTH_DAYS, daysLeft: Math.max(0, WHOLE30_LENGTH_DAYS - day + 1) };
}

export const INTERMITTENT_FASTING_SLUG = 'intermittent_fasting';
export const WHOLE30_SLUG = 'whole30';

/** Provider-set selection the patient has not yet acknowledged on this device. */
export function providerChangedDiet(diet: DietState | null, dismissedSelectionId: string | null): DietSelection | null {
  const current = diet?.currentDiet;
  if (!current || current.selectedByRole === 'patient') return null;
  if (dismissedSelectionId === current.id) return null;
  return current;
}

/** What the coach needs about the diet on a signed-in chat turn (null = nothing to send). */
export interface CoachDietContext {
  dietSlug: string;
  dietName: string;
  avoid: string[];
  dislikes: string[];
}

export function coachDietContextFor(diet: DietState | null): CoachDietContext | null {
  if (!diet) return null;
  const slug = diet.effectiveDietSlug ?? diet.currentDiet?.dietSlug ?? null;
  const entry = slug ? DIET_BY_SLUG.get(slug) : undefined;
  const label = (item: DietPreference) => item.label.trim();
  const avoid = diet.preferences.filter(item => item.list !== 'dislike').map(label).filter(Boolean);
  const dislikes = diet.preferences.filter(item => item.list === 'dislike').map(label).filter(Boolean);
  if (!entry && avoid.length === 0 && dislikes.length === 0) return null;
  return {
    dietSlug: entry?.slug ?? JUST_TRACKING_SLUG,
    dietName: entry?.name ?? '',
    avoid: [...new Set(avoid)].slice(0, 40),
    dislikes: [...new Set(dislikes)].slice(0, 40),
  };
}

/** Weekly cadence for the check-in's activity question: due when unset or 7+ days old. */
export function activityDueForCheckIn(activity: DietActivity | null, todayKey: string): boolean {
  if (!activity) return true;
  const last = Date.parse(`${activity.recordedOn.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(last) || !Number.isFinite(today)) return true;
  return today - last >= 7 * 24 * 60 * 60 * 1000;
}
