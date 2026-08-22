/**
 * Demo-patient parity check.
 *
 * The web dashboard's nutrition fixtures claim exact parity with the THINNR
 * mobile companion app's seeded history for the shared demo patient
 * (pat_100, Emma Smith), both pinned to the fixed anchor 2026-08-22T12:00:00Z.
 *
 * This script freezes that story as a snapshot: if anyone reintroduces
 * clock-derived dates, changes seed formulas, or reorders recipe pools, the
 * values below stop matching and the check fails. Run it under several TZ
 * values (see package script) — results must be identical in every timezone.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:parity
 */
import { MOCK_PATIENTS } from '../src/data/mock-data';
import {
  TODAY_KEY,
  getLoggingStats,
  getNutritionProfile,
  summarizeMeals,
} from '../src/data/nutrition-data';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label} = ${e}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}: expected ${e}, got ${a}`);
  }
}

console.log(`TZ=${process.env.TZ ?? '(system)'}\n`);

const emma = MOCK_PATIENTS.find((p) => p.id === 'pat_100');
if (!emma) throw new Error('Demo patient pat_100 missing from mock data');

// ─── Anchor ──────────────────────────────────────────────────────────────────
check('TODAY_KEY (fixed anchor)', TODAY_KEY, '2026-08-22');
check('enrollment date key', emma.startDate.slice(0, 10), '2026-05-20');

const profile = getNutritionProfile(emma);
const stats = getLoggingStats(emma);

// ─── History shape ───────────────────────────────────────────────────────────
check('seeded days (60 prior + today)', profile.days.length, 61);
check('first seeded date key', profile.days[0].dateKey, '2026-06-23');
const todayLog = profile.days[profile.days.length - 1];
check('last day is the anchor', todayLog.dateKey, '2026-08-22');
check('last day offset', todayLog.offset, 0);

// ─── Today's partial log (must mirror the mobile app's seeded "today") ──────
check(
  "today's meals",
  todayLog.meals.map((m) => `${m.meal}:${m.name}:${m.calories}`),
  [
    'breakfast:Greek Yogurt Protein Bowl:320',
    'breakfast:Coffee, black:2',
    'lunch:Grilled Chicken Cobb Salad:420',
    'snacks:Apple & Almond Butter:190',
  ],
);
check("today's water (oz)", todayLog.waterOz, 32);
check('today has no check-in yet', todayLog.checkIn ?? null, null);
const totals = summarizeMeals(todayLog.meals);
check("today's totals", totals, { calories: 932, protein: 73, carbs: 70, fat: 43 });

// ─── Yesterday (diligent demo patient never skips dinner) ────────────────────
const yesterday = profile.days[profile.days.length - 2];
check('yesterday logged', yesterday.logged, true);
check('yesterday has dinner', yesterday.meals.some((m) => m.meal === 'dinner'), true);

// ─── Logging stats (as rendered in the staff dashboard KPIs) ─────────────────
check('7-day logged days', stats.loggedDays7, 7);
check('7-day rate (%)', stats.rate7d, 100);
check('days since last log', stats.daysSinceLastLog, 0);
check('check-in streak', stats.checkInStreak, 20);
check('check-in rate 30d (%)', stats.checkInRate30, 97);
check('avg calories 7d', stats.avgCalories7, 1113);
check('avg water 7d (oz)', stats.avgWater7, 53);

// ─── Progress-photo milestones (dates from enrollment, weights from formula) ─
check(
  'photo milestones',
  profile.photos.map((p) => `${p.label}:${p.dateKey}`),
  ['Baseline:2026-05-20', 'Week 2:2026-06-03', 'Week 4:2026-06-17', 'Week 6:2026-07-01'],
);
check('baseline photo weight = starting weight', profile.photos[0]?.weight, 180);
const weights = profile.photos.map((p) => p.weight);
check('photo weights strictly decreasing', weights.every((w, i) => i === 0 || w < weights[i - 1]), true);
check('all demo photos have images', profile.photos.every((p) => Boolean(p.imageUrl)), true);

if (failures > 0) {
  console.error(`\n${failures} parity check(s) failed.`);
  process.exit(1);
}
console.log('\nAll demo-patient parity checks passed.');
