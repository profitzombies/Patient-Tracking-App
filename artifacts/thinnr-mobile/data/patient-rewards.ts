import type { CheckIn, MealLogEntry } from '@/data/patient-data';

export const REWARDS_CATALOG_VERSION = 1;
export const LEVEL_THRESHOLDS = [
  0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700,
  3200, 3700, 4200, 4700, 5200, 5700, 6200, 6700, 7200, 7700,
  8450, 9200, 9950, 10700, 11450, 12200, 12950, 13700, 14450, 15200,
  16200, 17200, 18200, 19200, 20200, 21200, 22200, 23200, 24200, 25200,
  26450, 27700, 28950, 30200, 31450, 32700, 33950, 35200, 36450, 37700,
] as const;

export type RewardId = string;
export type RewardIcon = 'book-open' | 'check-circle' | 'calendar' | 'droplet' | 'trending-down' | 'flag' | 'award';

export interface RewardAward {
  id: RewardId;
  category: 'level' | 'activity' | 'goal';
  title: string;
  description: string;
  requirement: string;
  icon: RewardIcon;
  threshold: number;
  progress: number;
  unit: string;
  earned: boolean;
  earnedAt?: string | null;
  xpAward: number;
}

export interface RewardSnapshotInput {
  entries: MealLogEntry[];
  checkIns: CheckIn[];
  waterFor: (dateKey: string) => number;
  waterTarget: number | null;
  startingWeight: number | null;
  currentWeight: number | null;
  todayKey?: string;
}

export interface DemoRewardState {
  catalogVersion: number;
  enrolledAt: string;
  enrollmentDate: string;
  totalXp: number;
  level: number;
  levelXp: number;
  nextLevelXp: number | null;
  xpToNextLevel: number;
  currentStreak: Record<string, number>;
  bestStreak: Record<string, number>;
  awards: RewardAward[];
  history: [];
  newlyUnlocked: [];
}

function daysOf(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function streakStats(days: string[], todayKey: string): { current: number; best: number } {
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of days) {
    const date = new Date(`${day}T00:00:00Z`);
    const prior = previous ? new Date(`${previous}T00:00:00Z`) : null;
    run = prior && date.getTime() - prior.getTime() === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const expected = new Date(`${todayKey}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() - (days.length - 1 - index));
    if (days[index] !== expected.toISOString().slice(0, 10)) break;
    current += 1;
  }
  return { current, best };
}

function iconForActivity(activity: string): RewardIcon {
  return activity === 'food' ? 'calendar' : activity === 'checkin' ? 'check-circle' : 'droplet';
}

function activityTitle(activity: string, threshold: number): string {
  const name = activity === 'food' ? 'Food rhythm' : activity === 'checkin' ? 'Check-in rhythm' : 'Hydration rhythm';
  return `${name} · ${threshold} days`;
}

function activityRequirement(activity: string, threshold: number, hasTarget: boolean): string {
  if (activity === 'hydration' && !hasTarget) return 'Set a personal hydration target to make this available';
  const action = activity === 'food' ? 'Log food' : activity === 'checkin' ? 'Complete check-ins' : 'Meet your hydration target';
  return `${action} on ${threshold} consecutive days`;
}

function makeAward(
  id: string,
  category: RewardAward['category'],
  title: string,
  description: string,
  requirement: string,
  icon: RewardIcon,
  threshold: number,
  progress: number,
  unit: string,
  earned: boolean,
  xpAward: number,
): RewardAward {
  return { id, category, title, description, requirement, icon, threshold, progress: Math.min(threshold, progress), unit, earned, earnedAt: earned ? 'demo' : null, xpAward };
}

export function buildRewardAwards(input: RewardSnapshotInput): RewardAward[] {
  const todayKey = input.todayKey ?? '2099-12-31';
  const foodDays = daysOf(input.entries.map(entry => entry.dateKey).filter(day => day <= todayKey));
  const checkinDays = daysOf(input.checkIns.map(checkIn => checkIn.dateKey).filter(day => day <= todayKey));
  const hydrationDays = input.waterTarget && input.waterTarget > 0
    ? daysOf([...new Set([...foodDays, ...checkinDays])].filter(day => input.waterFor(day) >= input.waterTarget!))
    : [];
  const streaks = {
    food: streakStats(foodDays, todayKey),
    checkin: streakStats(checkinDays, todayKey),
    hydration: streakStats(hydrationDays, todayKey),
  };
  const hasGoal = input.startingWeight !== null && input.currentWeight !== null && input.startingWeight > input.currentWeight;
  const poundsLost = hasGoal ? Math.max(0, input.startingWeight! - input.currentWeight!) : 0;
  const goalPercent = hasGoal ? Math.min(100, poundsLost / Math.max(1, input.startingWeight! - input.currentWeight!) * 100) : 0;
  const level = levelForXp(
    foodDays.length * 100 + checkinDays.length * 100 + hydrationDays.length * 100 +
      Object.values(streaks).reduce((sum, streak) => sum + [3, 7, 14, 30].filter(target => streak.best >= target).length * 250, 0) +
      [10, 25, 50, 75, 100].filter(target => goalPercent >= target).length * 500 +
      (poundsLost >= 5 ? 500 : 0),
  );
  const awards: RewardAward[] = [];
  for (const threshold of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
    awards.push(makeAward(`level:${threshold}`, 'level', `Level ${threshold} marker`, 'A level marker for steady work.', `Reach level ${threshold}`, 'award', threshold, level, 'level', level >= threshold, 0));
  }
  for (const [activity, stats] of Object.entries(streaks)) {
    for (const threshold of [3, 7, 14, 30]) {
      awards.push(makeAward(`streak:${activity}:${threshold}`, 'activity', activityTitle(activity, threshold), 'A consistency marker for steady work.', activityRequirement(activity, threshold, input.waterTarget !== null && input.waterTarget > 0), iconForActivity(activity), threshold, stats.best, 'days', stats.best >= threshold, 250));
    }
  }
  for (const threshold of [10, 25, 50, 75, 100]) {
    awards.push(makeAward(`goal:${threshold}`, 'goal', `Personal goal: ${threshold}%`, 'A milestone toward your personal goal.', `Reach ${threshold}% of your goal`, 'trending-down', threshold, goalPercent, '% of goal', goalPercent >= threshold, 500));
  }
  awards.push(makeAward('goal:five-pounds', 'goal', 'Five-pound marker', 'A personal milestone, measured on your terms.', 'Lose your first 5 lb toward a valid goal', 'trending-down', 5, poundsLost, 'lb toward goal', poundsLost >= 5, 500));
  return awards;
}

export function levelForXp(totalXp: number): number {
  let level = 1;
  LEVEL_THRESHOLDS.forEach((threshold, index) => {
    if (totalXp >= threshold) level = index + 1;
  });
  return level;
}

export function buildDemoRewardState(input: RewardSnapshotInput): DemoRewardState {
  const awards = buildRewardAwards(input);
  const foodDays = daysOf(input.entries.map(entry => entry.dateKey));
  const checkinDays = daysOf(input.checkIns.map(checkIn => checkIn.dateKey));
  const hydrationDays = input.waterTarget && input.waterTarget > 0 ? foodDays.filter(day => input.waterFor(day) >= input.waterTarget!) : [];
  const stats = { food: streakStats(foodDays, input.todayKey ?? '2099-12-31'), checkin: streakStats(checkinDays, input.todayKey ?? '2099-12-31'), hydration: streakStats(hydrationDays, input.todayKey ?? '2099-12-31') };
  const totalXp = foodDays.length * 100 + checkinDays.length * 100 + hydrationDays.length * 100 + awards.filter(award => award.category !== 'level' && award.earned).reduce((sum, award) => sum + award.xpAward, 0);
  const level = levelForXp(totalXp);
  const levelXp = LEVEL_THRESHOLDS[level - 1] ?? 0;
  const nextLevelXp = LEVEL_THRESHOLDS[level] ?? null;
  return {
    catalogVersion: REWARDS_CATALOG_VERSION,
    enrolledAt: 'demo',
    enrollmentDate: input.todayKey ?? 'demo',
    totalXp,
    level,
    levelXp,
    nextLevelXp,
    xpToNextLevel: nextLevelXp === null ? 0 : Math.max(0, nextLevelXp - totalXp),
    currentStreak: { food: stats.food.current, checkin: stats.checkin.current, hydration: stats.hydration.current },
    bestStreak: { food: stats.food.best, checkin: stats.checkin.best, hydration: stats.hydration.best },
    awards,
    history: [],
    newlyUnlocked: [],
  };
}