/**
 * Synthetic nutrition & lifestyle logs for the staff dashboard.
 *
 * This mirrors the patient data model of the THINNR mobile companion app
 * (artifacts/thinnr-mobile/data/patient-data.ts). The demo is frontend-only,
 * so the web app seeds its own deterministic fixtures — no live sync.
 *
 * The demo patient pat_100 (Emma Smith) uses the exact same seed formulas and
 * recipe pools as the mobile app, so her meal diary, water totals, check-ins,
 * and progress-photo milestones line up with what the companion app shows.
 * Every other patient gets a deterministic logging archetype (diligent,
 * steady, variable, or lapsing) salted by their patient index.
 */
import type { Patient } from './mock-data';

// ─── Shared model (aligned with the mobile companion app) ────────────────────

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

export const MEAL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snacks'];

export const MEAL_LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snacks: 'Snacks',
};

export interface MealLogEntry {
  id: string;
  dateKey: string;
  meal: MealSlot;
  kind: 'food' | 'recipe';
  name: string;
  detail: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface DayCheckIn {
  mood: 1 | 2 | 3 | 4 | 5;
  sideEffects: string[];
  weight?: number;
  note?: string;
}

export interface DailyLog {
  dateKey: string;
  /** Days before today (0 = today). */
  offset: number;
  logged: boolean;
  meals: MealLogEntry[];
  waterOz: number;
  checkIn?: DayCheckIn;
}

export interface ProgressPhoto {
  id: string;
  dateKey: string;
  label: string;
  weight: number;
  /** Only the demo patient has real seeded photo assets. */
  imageUrl?: string;
}

export interface DailyTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterOz: number;
}

export type LoggingArchetype = 'diligent' | 'steady' | 'variable' | 'lapsing';

export interface NutritionProfile {
  patientId: string;
  archetype: LoggingArchetype;
  targets: DailyTargets;
  /** Oldest → newest, ending with today. */
  days: DailyLog[];
  photos: ProgressPhoto[];
}

export interface LoggingStats {
  /** Last 7 calendar days (oldest → newest, ending today): logged or not. */
  last7: boolean[];
  loggedDays7: number;
  /** 0–100. */
  rate7d: number;
  /** 0 = logged today; null = never logged. */
  daysSinceLastLog: number | null;
  mealStreak: number;
  checkInStreak: number;
  /** 0–100 over the last 30 prior days. */
  checkInRate30: number;
  avgCalories7: number;
  avgWater7: number;
  moodCounts: Record<1 | 2 | 3 | 4 | 5, number>;
  topSideEffects: { name: string; count: number }[];
  lastCheckInDateKey: string | null;
}

export const DEFAULT_TARGETS: DailyTargets = {
  calories: 1500,
  protein: 120,
  carbs: 130,
  fat: 50,
  waterOz: 64,
};

export const WATER_CUP_OZ = 8;

export const MOOD_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Rough',
  2: 'Low',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
};

export const ARCHETYPE_LABELS: Record<LoggingArchetype, string> = {
  diligent: 'Diligent logger',
  steady: 'Steady logger',
  variable: 'Inconsistent logger',
  lapsing: 'Logging lapsed',
};

/** Number of prior days of history to seed (same window as the mobile app). */
export const SEED_DAYS = 60;

// ─── Deterministic helpers (same formulas as the mobile app) ─────────────────

const seededFraction = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

/**
 * Fixed anchor — the same fictional "today" the mobile companion app pins in
 * artifacts/thinnr-mobile/data/patient-data.ts. Never derive this from the
 * viewer's clock: the demo is a snapshot in time, and UTC day arithmetic keeps
 * every date key identical to the mobile app regardless of timezone.
 */
const today = new Date('2026-08-22T12:00:00.000Z');

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const subDays = (date: Date, days: number): Date => addDays(date, -days);
const toDateKey = (date: Date) => date.toISOString().slice(0, 10);

export const TODAY_KEY = toDateKey(today);

export function formatDateKey(dateKey: string, includeYear = false): string {
  return new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Seed catalog (names + nutrition copied from the mobile recipe library) ──

interface SeedDish {
  name: string;
  detail: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

const dish = (name: string, calories: number, protein: number, carbs: number, fat: number, detail = '1 serving'): SeedDish =>
  ({ name, detail, calories, protein, carbs, fat });

// Pool order matters: it matches the mobile app's recipe library order so the
// deterministic picks reproduce the same meals for the demo patient.
const BREAKFASTS: SeedDish[] = [
  dish('Greek Yogurt Protein Bowl', 320, 28, 34, 9),
  dish('Spinach & Egg White Scramble', 210, 26, 6, 9),
  dish('Blueberry Overnight Oats', 340, 18, 52, 8),
  dish('Avocado Toast with Poached Egg', 310, 14, 28, 16),
  dish('Cottage Cheese Berry Parfait', 250, 24, 20, 8),
];

const LUNCHES: SeedDish[] = [
  dish('Grilled Chicken Cobb Salad', 420, 40, 12, 24),
  dish('Turkey & Quinoa Power Bowl', 460, 35, 48, 13),
  dish('Mediterranean Tuna Wrap', 380, 32, 36, 12),
  dish('Lentil & Vegetable Soup', 290, 18, 42, 5),
  dish('Shrimp & Zucchini Noodle Bowl', 300, 34, 12, 13),
];

const DINNERS: SeedDish[] = [
  dish('Baked Salmon & Asparagus', 430, 38, 10, 26),
  dish('Herb Roast Chicken & Vegetables', 410, 42, 22, 16),
  dish('Turkey Meatballs & Zoodles', 390, 36, 18, 19),
  dish('Seared Cod & Broccolini', 320, 34, 9, 16),
  dish('Lean Beef Stir-Fry', 400, 34, 24, 18),
];

const SNACK_DISHES: SeedDish[] = [
  dish('Almond Energy Bites', 180, 6, 18, 10),
  dish('Cucumber Hummus Bites', 120, 5, 14, 6),
  dish('Apple & Almond Butter', 190, 5, 24, 10),
  dish('Seasoned Hard-Boiled Eggs', 140, 12, 1, 9),
  dish('Chocolate Protein Smoothie', 280, 30, 28, 6),
];

const COFFEE: SeedDish = dish('Coffee, black', 2, 0, 0, 0, '1 cup');
const APPLE: SeedDish = dish('Apple', 95, 0, 25, 0, '1 medium');
const SPARKLING: SeedDish = dish('Sparkling Water', 0, 0, 0, 0, '12 fl oz');

const CHECKIN_NOTES = [
  'Felt steady today. Meals were easy to stick to.',
  'Busy day but kept up with water and walks.',
  'Slept well and energy is holding.',
  'Prepped meals for the next two days.',
  'Craving hit in the afternoon — tea helped.',
  'Weekend routine held up better than expected.',
];

const SIDE_EFFECT_CHANCES: { name: string; chance: number }[] = [
  { name: 'Nausea', chance: 0.04 },
  { name: 'Headache', chance: 0.06 },
  { name: 'Fatigue', chance: 0.06 },
  { name: 'Dizziness', chance: 0.02 },
  { name: 'Constipation', chance: 0.03 },
];

const pickFrom = <T,>(arr: T[], seed: number): T =>
  arr[Math.floor(seededFraction(seed) * arr.length) % arr.length];

// ─── Archetype parameters ────────────────────────────────────────────────────

interface ArchetypeParams {
  logChance: number;
  checkInSkip: number;
  snackChance: number;
  dinnerMissChance: number;
  waterBaseOz: number;
  waterSteps: number;
  moodProfile: 'good' | 'mixed' | 'low';
  sideEffectFactor: number;
}

const ARCHETYPE_PARAMS: Record<LoggingArchetype, ArchetypeParams> = {
  diligent: { logChance: 0.96, checkInSkip: 0.16, snackChance: 0.55, dinnerMissChance: 0, waterBaseOz: 40, waterSteps: 5, moodProfile: 'good', sideEffectFactor: 1 },
  steady: { logChance: 0.86, checkInSkip: 0.3, snackChance: 0.45, dinnerMissChance: 0.12, waterBaseOz: 32, waterSteps: 6, moodProfile: 'good', sideEffectFactor: 1.2 },
  variable: { logChance: 0.68, checkInSkip: 0.5, snackChance: 0.3, dinnerMissChance: 0.25, waterBaseOz: 24, waterSteps: 5, moodProfile: 'mixed', sideEffectFactor: 1.6 },
  lapsing: { logChance: 0.8, checkInSkip: 0.45, snackChance: 0.35, dinnerMissChance: 0.2, waterBaseOz: 24, waterSteps: 5, moodProfile: 'low', sideEffectFactor: 1.8 },
};

const patientIndex = (patient: Patient): number => {
  const parsed = Number(patient.id.replace('pat_', ''));
  return Number.isFinite(parsed) ? Math.max(0, parsed - 100) : 7;
};

function archetypeFor(patient: Patient, idx: number): LoggingArchetype {
  if (patient.id === 'pat_100') return 'diligent'; // Demo patient mirrors the mobile app.
  if (patient.status === 'paused' || patient.status === 'overdue') return 'lapsing';
  if (idx % 7 === 0) return 'lapsing'; // The mock data's "at risk" cohort.
  const roll = seededFraction(idx * 57 + 11);
  if (roll < 0.45) return 'diligent';
  if (roll < 0.8) return 'steady';
  return 'variable';
}

// ─── Generator ───────────────────────────────────────────────────────────────

const mealEntry = (dateKey: string, meal: MealSlot, kind: 'food' | 'recipe', d: SeedDish, n: number): MealLogEntry => ({
  id: `seed_${dateKey}_${meal}_${n}`,
  dateKey,
  meal,
  kind,
  name: d.name,
  detail: d.detail,
  calories: d.calories,
  protein: d.protein,
  carbs: d.carbs,
  fat: d.fat,
});

function mealsForDay(dateKey: string, offset: number, salt: number, params: ArchetypeParams): MealLogEntry[] {
  const meals: MealLogEntry[] = [
    mealEntry(dateKey, 'breakfast', 'recipe', pickFrom(BREAKFASTS, salt + offset * 7 + 1), 0),
  ];
  if (seededFraction(salt + offset * 11 + 4) < 0.72) {
    meals.push(mealEntry(dateKey, 'breakfast', 'food', COFFEE, 1));
  }

  meals.push(mealEntry(dateKey, 'lunch', 'recipe', pickFrom(LUNCHES, salt + offset * 7 + 2), 0));
  if (seededFraction(salt + offset * 11 + 5) < 0.38) {
    meals.push(mealEntry(dateKey, 'lunch', 'food', seededFraction(salt + offset * 13 + 6) < 0.5 ? APPLE : SPARKLING, 1));
  }

  if (!(params.dinnerMissChance > 0 && seededFraction(salt + offset * 11 + 8) < params.dinnerMissChance)) {
    meals.push(mealEntry(dateKey, 'dinner', 'recipe', pickFrom(DINNERS, salt + offset * 7 + 3), 0));
  }

  if (seededFraction(salt + offset * 11 + 6) < params.snackChance) {
    meals.push(mealEntry(dateKey, 'snacks', 'recipe', pickFrom(SNACK_DISHES, salt + offset * 7 + 4), 0));
  }
  return meals;
}

function weightOnProgramDay(patient: Patient, salt: number, elapsed: number, enrollmentDays: number): number {
  const start = patient.startingWeight;
  const current = patient.currentWeight;
  const progress = Math.min(1, Math.max(0, elapsed / enrollmentDays));
  const taper = Math.pow(progress, patient.status === 'graduated' ? 0.78 : 0.91);
  const variation = elapsed === 0 || elapsed >= enrollmentDays
    ? 0
    : (seededFraction(salt + elapsed * 41 + 7) - 0.5) * 1.1;
  const weight = start - (start - current) * taper + variation;
  return parseFloat(Math.max(current - 0.4, weight).toFixed(1));
}

function moodFor(roll: number, profile: ArchetypeParams['moodProfile']): 1 | 2 | 3 | 4 | 5 {
  if (profile === 'good') return roll < 0.1 ? 3 : roll > 0.72 ? 5 : 4; // Mobile app formula.
  if (profile === 'mixed') return roll < 0.12 ? 2 : roll < 0.35 ? 3 : roll > 0.8 ? 5 : 4;
  return roll < 0.15 ? 2 : roll < 0.5 ? 3 : roll > 0.88 ? 5 : 4;
}

function sideEffectsFor(offset: number, salt: number, params: ArchetypeParams): string[] {
  if (params.moodProfile === 'good') {
    // Mobile app formula: an occasional headache, nothing else.
    return seededFraction(salt + offset * 9 + 3) < 0.08 ? ['Headache'] : [];
  }
  const effects: string[] = [];
  SIDE_EFFECT_CHANCES.forEach((option, index) => {
    if (effects.length < 2 && seededFraction(salt + offset * 9 + 31 + index * 5) < option.chance * params.sideEffectFactor) {
      effects.push(option.name);
    }
  });
  return effects;
}

function checkInForDay(patient: Patient, salt: number, offset: number, enrollmentDays: number, params: ArchetypeParams): DayCheckIn | undefined {
  if (seededFraction(salt + offset * 3 + 2) < params.checkInSkip) return undefined;
  const moodRoll = seededFraction(salt + offset * 5 + 9);
  const checkIn: DayCheckIn = {
    mood: moodFor(moodRoll, params.moodProfile),
    sideEffects: sideEffectsFor(offset, salt, params),
  };
  if (offset % 2 === 0) checkIn.weight = weightOnProgramDay(patient, salt, enrollmentDays - offset, enrollmentDays);
  if (seededFraction(salt + offset * 17 + 11) < 0.3) {
    checkIn.note = CHECKIN_NOTES[Math.floor(seededFraction(salt + offset * 19 + 13) * CHECKIN_NOTES.length) % CHECKIN_NOTES.length];
  }
  return checkIn;
}

function todayMeals(salt: number, archetype: LoggingArchetype, isDemoPatient: boolean): { meals: MealLogEntry[]; waterOz: number } {
  if (isDemoPatient) {
    // Exact partial day the mobile app seeds: dinner is still open.
    return {
      waterOz: 32,
      meals: [
        mealEntry(TODAY_KEY, 'breakfast', 'recipe', BREAKFASTS[0], 0),
        mealEntry(TODAY_KEY, 'breakfast', 'food', COFFEE, 1),
        mealEntry(TODAY_KEY, 'lunch', 'recipe', LUNCHES[0], 0),
        mealEntry(TODAY_KEY, 'snacks', 'recipe', SNACK_DISHES[2], 0),
      ],
    };
  }
  if (archetype === 'lapsing') return { meals: [], waterOz: 0 };
  if (archetype === 'variable') {
    if (seededFraction(salt + 5) < 0.55) {
      return { meals: [mealEntry(TODAY_KEY, 'breakfast', 'recipe', pickFrom(BREAKFASTS, salt + 1), 0)], waterOz: 16 };
    }
    return { meals: [], waterOz: 8 };
  }
  const meals: MealLogEntry[] = [mealEntry(TODAY_KEY, 'breakfast', 'recipe', pickFrom(BREAKFASTS, salt + 1), 0)];
  if (seededFraction(salt + 4) < 0.72) meals.push(mealEntry(TODAY_KEY, 'breakfast', 'food', COFFEE, 1));
  if (archetype === 'diligent' || seededFraction(salt + 3) < 0.75) {
    meals.push(mealEntry(TODAY_KEY, 'lunch', 'recipe', pickFrom(LUNCHES, salt + 2), 0));
  }
  if (archetype === 'diligent' && seededFraction(salt + 6) < 0.55) {
    meals.push(mealEntry(TODAY_KEY, 'snacks', 'recipe', pickFrom(SNACK_DISHES, salt + 7), 0));
  }
  return { meals, waterOz: archetype === 'diligent' ? 32 : 24 };
}

const PHOTO_MILESTONES: { elapsed: number; label: string; asset: string }[] = [
  { elapsed: 0, label: 'Baseline', asset: 'baseline.jpg' },
  { elapsed: 14, label: 'Week 2', asset: 'week-2.jpg' },
  { elapsed: 28, label: 'Week 4', asset: 'week-4.jpg' },
  { elapsed: 42, label: 'Week 6', asset: 'week-6.jpg' },
];

function buildPhotos(patient: Patient, salt: number, enrollmentDays: number): ProgressPhoto[] {
  const isDemoPatient = patient.id === 'pat_100';
  const startDate = new Date(patient.startDate);
  return PHOTO_MILESTONES
    .filter((milestone) => milestone.elapsed <= enrollmentDays)
    .map((milestone) => ({
      id: `photo_${patient.id}_${milestone.elapsed}`,
      dateKey: toDateKey(addDays(startDate, milestone.elapsed)),
      label: milestone.label,
      weight: weightOnProgramDay(patient, salt, milestone.elapsed, enrollmentDays),
      imageUrl: isDemoPatient ? `${import.meta.env?.BASE_URL ?? '/'}progress/${milestone.asset}` : undefined,
    }));
}

const profileCache = new Map<string, NutritionProfile>();

export function getNutritionProfile(patient: Patient): NutritionProfile {
  const cached = profileCache.get(patient.id);
  if (cached) return cached;

  const idx = patientIndex(patient);
  const isDemoPatient = patient.id === 'pat_100';
  // Salt 0 for the demo patient reproduces the mobile app's exact seeds.
  const salt = idx * 1013;
  const archetype = archetypeFor(patient, idx);
  const params = ARCHETYPE_PARAMS[archetype];
  const enrollmentDays = Math.max(1, Math.round((today.getTime() - new Date(patient.startDate).getTime()) / 86_400_000));
  const priorDays = Math.min(SEED_DAYS, enrollmentDays);
  const gapDays = archetype === 'lapsing'
    ? Math.min(
        patient.status === 'paused' ? 6 + Math.floor(seededFraction(salt + 91) * 9) : 3 + Math.floor(seededFraction(salt + 91) * 7),
        Math.max(3, priorDays - 4),
      )
    : 0;

  const days: DailyLog[] = [];
  for (let offset = priorDays; offset >= 1; offset--) {
    const dateKey = toDateKey(subDays(today, offset));
    const inGap = archetype === 'lapsing' && offset < gapDays;
    const logged = !inGap && (isDemoPatient || seededFraction(salt + offset * 23 + 8) < params.logChance);
    if (!logged) {
      days.push({ dateKey, offset, logged: false, meals: [], waterOz: 0 });
      continue;
    }
    days.push({
      dateKey,
      offset,
      logged: true,
      meals: mealsForDay(dateKey, offset, salt, isDemoPatient ? { ...params, dinnerMissChance: 0 } : params),
      waterOz: params.waterBaseOz + Math.floor(seededFraction(salt + offset * 13 + 5) * params.waterSteps) * 8,
      checkIn: checkInForDay(patient, salt, offset, enrollmentDays, params),
    });
  }

  // Today: a partial log (the mobile app never seeds a check-in for today).
  const partial = todayMeals(salt, archetype, isDemoPatient);
  days.push({ dateKey: TODAY_KEY, offset: 0, logged: partial.meals.length > 0, meals: partial.meals, waterOz: partial.waterOz });

  const profile: NutritionProfile = {
    patientId: patient.id,
    archetype,
    targets: { ...DEFAULT_TARGETS },
    days,
    photos: buildPhotos(patient, salt, enrollmentDays),
  };
  profileCache.set(patient.id, profile);
  return profile;
}

// ─── Derived helpers ─────────────────────────────────────────────────────────

export function summarizeMeals(meals: MealLogEntry[]): { calories: number; protein: number; carbs: number; fat: number } {
  return meals.reduce(
    (acc, entry) => ({
      calories: acc.calories + entry.calories,
      protein: acc.protein + entry.protein,
      carbs: acc.carbs + entry.carbs,
      fat: acc.fat + entry.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

const statsCache = new Map<string, LoggingStats>();

export function getLoggingStats(patient: Patient): LoggingStats {
  const cached = statsCache.get(patient.id);
  if (cached) return cached;

  const { days } = getNutritionProfile(patient);
  const newestFirst = [...days].reverse();

  const last7Days = days.slice(-7);
  const last7 = last7Days.map((day) => day.logged);
  const loggedDays7 = last7.filter(Boolean).length;

  const firstLogged = newestFirst.find((day) => day.logged);
  const daysSinceLastLog = firstLogged ? firstLogged.offset : null;

  let mealStreak = 0;
  for (const day of newestFirst) {
    if (day.offset === 0 && !day.logged) continue; // Today still open: does not break a streak.
    if (!day.logged) break;
    mealStreak++;
  }

  let checkInStreak = 0;
  for (const day of newestFirst) {
    if (day.offset === 0) continue; // Check-ins are never seeded for today.
    if (!day.checkIn) break;
    checkInStreak++;
  }

  const last30 = days.filter((day) => day.offset >= 1 && day.offset <= 30);
  const checkIns30 = last30.filter((day) => day.checkIn);
  const checkInRate30 = last30.length ? Math.round((checkIns30.length / last30.length) * 100) : 0;

  const loggedLast7 = last7Days.filter((day) => day.logged);
  const avgCalories7 = loggedLast7.length
    ? Math.round(loggedLast7.reduce((total, day) => total + summarizeMeals(day.meals).calories, 0) / loggedLast7.length)
    : 0;
  const waterDays7 = last7Days.filter((day) => day.waterOz > 0);
  const avgWater7 = waterDays7.length
    ? Math.round(waterDays7.reduce((total, day) => total + day.waterOz, 0) / waterDays7.length)
    : 0;

  const moodCounts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sideEffectCounts = new Map<string, number>();
  checkIns30.forEach((day) => {
    const checkIn = day.checkIn!;
    moodCounts[checkIn.mood] += 1;
    checkIn.sideEffects.forEach((effect) => sideEffectCounts.set(effect, (sideEffectCounts.get(effect) ?? 0) + 1));
  });
  const topSideEffects = [...sideEffectCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const lastCheckInDay = newestFirst.find((day) => day.checkIn);

  const stats: LoggingStats = {
    last7,
    loggedDays7,
    rate7d: Math.round((loggedDays7 / 7) * 100),
    daysSinceLastLog,
    mealStreak,
    checkInStreak,
    checkInRate30,
    avgCalories7,
    avgWater7,
    moodCounts,
    topSideEffects,
    lastCheckInDateKey: lastCheckInDay?.dateKey ?? null,
  };
  statsCache.set(patient.id, stats);
  return stats;
}

/**
 * Range-scoped logging summary for the staff record's nutrition section.
 *
 * Unlike getLoggingStats (fixed 7/30-day windows ending on the anchor), this
 * aggregates only the seeded days whose date keys fall inside the shared
 * operations date range (inclusive). Longitudinal "as of today" statuses —
 * streaks, days-since-last-log — intentionally stay in LoggingStats; they are
 * current facts, not range summaries.
 */
export interface RangeLoggingSummary {
  /** Seeded companion-app days inside the range, oldest → newest. */
  days: DailyLog[];
  /** Days of seeded history available inside the range. */
  daysWithData: number;
  loggedDays: number;
  /** 0–100 over daysWithData. */
  loggedRate: number;
  /** Average calories over logged days in range (0 when none). */
  avgCalories: number;
  /** Average ounces over days with any water in range (0 when none). */
  avgWater: number;
  /** Days eligible for a check-in (the anchor day never seeds one). */
  checkInEligibleDays: number;
  checkInCount: number;
  /** 0–100 over eligible days. */
  checkInRate: number;
  moodCounts: Record<1 | 2 | 3 | 4 | 5, number>;
  topSideEffects: { name: string; count: number }[];
}

export function getRangeLoggingSummary(
  patient: Patient,
  range: { start: string; end: string },
): RangeLoggingSummary {
  const { days } = getNutritionProfile(patient);
  const inRange = days.filter((day) => day.dateKey >= range.start && day.dateKey <= range.end);

  const logged = inRange.filter((day) => day.logged);
  const avgCalories = logged.length
    ? Math.round(logged.reduce((total, day) => total + summarizeMeals(day.meals).calories, 0) / logged.length)
    : 0;
  const waterDays = inRange.filter((day) => day.waterOz > 0);
  const avgWater = waterDays.length
    ? Math.round(waterDays.reduce((total, day) => total + day.waterOz, 0) / waterDays.length)
    : 0;

  // Mirrors checkInRate30's semantics: today never seeds a check-in, so the
  // anchor day is excluded from the denominator instead of counting as a miss.
  const eligible = inRange.filter((day) => day.offset >= 1);
  const withCheckIn = eligible.filter((day) => day.checkIn);
  const moodCounts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sideEffectCounts = new Map<string, number>();
  withCheckIn.forEach((day) => {
    const checkIn = day.checkIn!;
    moodCounts[checkIn.mood] += 1;
    checkIn.sideEffects.forEach((effect) => sideEffectCounts.set(effect, (sideEffectCounts.get(effect) ?? 0) + 1));
  });
  const topSideEffects = [...sideEffectCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return {
    days: inRange,
    daysWithData: inRange.length,
    loggedDays: logged.length,
    loggedRate: inRange.length ? Math.round((logged.length / inRange.length) * 100) : 0,
    avgCalories,
    avgWater,
    checkInEligibleDays: eligible.length,
    checkInCount: withCheckIn.length,
    checkInRate: eligible.length ? Math.round((withCheckIn.length / eligible.length) * 100) : 0,
    moodCounts,
    topSideEffects,
  };
}

/** Threshold (in days without any log) at which a patient counts as lapsed. */
export const LAPSED_AFTER_DAYS = 3;

export function isLapsed(stats: LoggingStats): boolean {
  return stats.daysSinceLastLog === null || stats.daysSinceLastLog >= LAPSED_AFTER_DAYS;
}

export function lastLogLabel(stats: LoggingStats): string {
  if (stats.daysSinceLastLog === null) return 'No logs yet';
  if (stats.daysSinceLastLog === 0) return 'Logged today';
  if (stats.daysSinceLastLog === 1) return 'Logged yesterday';
  return `Last log ${stats.daysSinceLastLog}d ago`;
}
