/**
 * Diet classifier / calculator parity check.
 *
 * The API and the app each import the shared diet-programs library. This
 * script runs the shared parity fixture through the APP's import seam
 * (lib/diet-fit.ts) and checks every verdict and reason code against the
 * fixture's expected values — the same assertions the API's vitest suite
 * makes — so a drift in either import path (a stale dist, a shadowed
 * module, a mobile wrapper that mutates the food) fails here.
 *
 * It also proves the mobile-only piece: the Approved Foods bridge decides
 * protocol-phase verdicts, and the phase/target helpers match the server's
 * published semantics (the start date reads as day 1, day 43 = maintenance).
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:diet-parity
 */
import { PARITY_CASES } from '@workspace/diet-programs/fixtures';
import { classifyFood as sharedClassify } from '@workspace/diet-programs';

import {
  calculateTargets,
  classifyCatalogFood,
  classifyFood,
  derivePhase,
  describeCatalogFood,
  programDayBetween,
  PROTOCOL_LENGTH_DAYS,
} from '../lib/diet-fit';
import { APPROVED_MATCH_BY_FOOD } from '../data/approved-foods';

let checks = 0;
let failures = 0;
function check(condition: boolean, label: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

// 1. Every fixture case gives the fixture's verdict through the app seam.
check(PARITY_CASES.length >= 10, `parity fixture has a meaningful number of cases (${PARITY_CASES.length})`);
for (const testCase of PARITY_CASES) {
  const result = classifyFood(testCase.food, testCase.context);
  check(result.verdict === testCase.expected, `${testCase.id}: expected ${testCase.expected}, got ${result.verdict}`);
  const codes = result.reasons.map((reason) => reason.code);
  for (const code of testCase.expectReasons ?? []) check(codes.includes(code), `${testCase.id}: missing reason ${code}`);
  // 2. The app seam is the shared function, byte for byte on output.
  const direct = sharedClassify(testCase.food, testCase.context);
  check(JSON.stringify(direct) === JSON.stringify(result), `${testCase.id}: app seam and shared classifier disagree`);
}

// 3. Approved Foods bridge: a known approved catalog food fits the protocol,
//    an unknown id is "does not fit", and the bridge never overrides an
//    explicit answer or touches non-protocol classification.
const approvedFoodId = Object.keys(APPROVED_MATCH_BY_FOOD)[0];
check(typeof approvedFoodId === 'string', 'approved-foods map has at least one catalog food');
const protocol = { dietSlug: 'carnivore', phase: 'protocol' as const };
check(classifyCatalogFood({ name: 'Approved item' }, approvedFoodId, protocol).verdict === 'fits', 'approved catalog food fits during the protocol');
const notApproved = classifyCatalogFood({ name: 'Mystery bar' }, 'not-a-real-food-id', protocol);
check(notApproved.verdict === 'does_not_fit', 'unknown catalog food does not fit during the protocol');
check(notApproved.reasons.some((reason) => reason.code === 'protocol:not_approved'), 'protocol miss carries protocol:not_approved');
check(classifyCatalogFood({ name: 'No id' }, undefined, protocol).verdict === 'does_not_fit', 'missing food id is treated as not approved during the protocol');
check(describeCatalogFood({ name: 'Explicit', thinnrApproved: true }, 'not-a-real-food-id').thinnrApproved === true, 'explicit thinnrApproved wins over the bridge');
const maintenance = classifyCatalogFood({ name: 'Salami', tags: ['processed_meat'] }, approvedFoodId, { dietSlug: 'mediterranean', phase: 'maintenance' });
check(maintenance.verdict === 'does_not_fit' && maintenance.reasons.every((reason) => reason.source !== 'protocol'), 'maintenance ignores the Approved Foods bridge and applies the diet');

// 4. Phase semantics shared with the server.
check(programDayBetween('2026-01-01', '2026-01-01') === 1, 'start date reads as day 1');
check(programDayBetween('2026-01-01', '2026-02-12') === PROTOCOL_LENGTH_DAYS, '42 days after the start is day 42 (shared whole-days semantics)');
check(programDayBetween('2026-01-01', '2026-02-13') === PROTOCOL_LENGTH_DAYS + 1, 'day 43 follows the 42-day protocol');
check(derivePhase({ episodeStartedOn: '2026-01-01', todayKey: '2026-02-12', programId: 'thinnr' }).phase === 'protocol', 'day 42 is still protocol');
const day43 = derivePhase({ episodeStartedOn: '2026-01-01', todayKey: '2026-02-13', programId: 'thinnr' });
check(day43.phase === 'maintenance' && day43.maintenanceDay === 1 && !day43.dietPickerLocked, 'day 43 is maintenance day 1 with the picker unlocked');
check(!derivePhase({ episodeStartedOn: '2026-01-01', todayKey: '2026-01-05', programId: 'glp1' }).dietPickerLocked, 'GLP-1 patients are never locked');

// 5. Target calculator: overrides win, ramp climbs toward maintenance.
const base = { gender: 'female' as const, ageYears: 40, heightInches: 65, weightLb: 180, goalWeightLb: 150, activityLevel: 'sedentary' as const, phase: 'maintenance' as const, programDay: 50, maintenanceDay: 8 };
const calculated = calculateTargets(base);
check(calculated.calculated.calories > 0 && calculated.effective.calories === calculated.calculated.calories, 'calculated targets flow to effective when nothing is overridden');
const overridden = calculateTargets(base, { calories: 1234 });
check(overridden.effective.calories === 1234 && overridden.overridden.includes('calories'), 'patient calorie override wins');
const earlier = calculateTargets({ ...base, maintenanceDay: 1 });
check(earlier.calculated.calories <= calculated.calculated.calories, 'maintenance ramp does not step calories down over time');

if (failures > 0) {
  console.error(`diet parity: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`diet parity: ${checks} checks passed`);
