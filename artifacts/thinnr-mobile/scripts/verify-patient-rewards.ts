import {
  buildDemoRewardState,
  buildRewardAwards,
  LEVEL_THRESHOLDS,
  levelForXp,
} from '../data/patient-rewards';

const fail = (message: string): never => {
  throw new Error(`patient rewards: ${message}`);
};
const expect = (condition: unknown, message: string): void => {
  if (!condition) fail(message);
};

const days = ['2026-09-18', '2026-09-19', '2026-09-20'];
const input = {
  entries: days.map(dateKey => ({ id: `food-${dateKey}`, dateKey } as never)),
  checkIns: days.map(dateKey => ({ id: `checkin-${dateKey}`, dateKey } as never)),
  waterFor: (dateKey: string) => (dateKey === '2026-09-19' ? 70 : 80),
  waterTarget: 80,
  startingWeight: 200,
  currentWeight: 198,
  todayKey: '2026-09-20',
};

expect(LEVEL_THRESHOLDS[9] === 2700 && LEVEL_THRESHOLDS[49] === 37700, 'level checkpoints');
expect(levelForXp(0) === 1 && levelForXp(300) === 2 && levelForXp(37700) === 50, 'level boundaries');
const awards = buildRewardAwards(input);
expect(awards.some(award => award.id === 'streak:food:3' && award.earned && award.xpAward === 250), 'food streak award');
expect(!awards.some(award => award.id === 'streak:hydration:3' && award.earned), 'hydration requires three eligible days');
expect(awards.some(award => award.id === 'goal:five-pounds' && !award.earned), 'five-pound goal remains locked');
const noTarget = buildRewardAwards({ ...input, waterTarget: null });
expect(noTarget.find(award => award.id === 'streak:hydration:3')?.requirement.includes('Set a personal hydration target') === true, 'no-target explanation');
const demo = buildDemoRewardState(input);
expect(demo.totalXp > 0 && demo.level >= 1 && demo.nextLevelXp === LEVEL_THRESHOLDS[demo.level]!, 'demo state uses the same catalog');
console.log('✓ patient reward rules: checkpoints, streaks, target gating, goals, and demo state verified');