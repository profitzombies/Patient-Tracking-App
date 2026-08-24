/**
 * Provider accounts — the HQ umbrella's sub-accounts.
 *
 * Each seeded account wraps one of the four seeded office providers (p1–p4)
 * and is linked by the same six-digit provider code patients type during
 * mobile onboarding (Dr. Jenkins' account keeps 123456, the code the mobile
 * demo accepts). Every per-account figure is a hand-picked exact split of the
 * program-wide MOCK_ANALYTICS numbers, so HQ rollups always agree with the
 * office demo at the fixed Aug 22, 2026 anchor:
 *
 *   recurring   27,500 + 35,800 + 40,600 + 18,300 = 122,200
 *   enrollment  14,000 + 18,100 + 20,700 +  9,200 =  62,000
 *   patients       142 +    185 +    210 +     95 =    632
 *   enrollments     19 +     25 +     28 +     12 =     84
 *
 * Weighted averages reproduce the program headlines too (goal completion
 * 88.2%, 24.5 lbs average loss, 94.5% retention, 89.5% engagement).
 * No viewer-clock math anywhere — everything is anchored to the demo date.
 */
import { MOCK_ANALYTICS, getDailyRevenue } from '../mock-data';

export type AccountStatus = 'active' | 'pending';
export type AccountPlan = 'Core' | 'Plus' | 'Concierge';

export interface ProviderAccount {
  id: string;
  /** Seeded office provider this account wraps; null for session-added accounts. */
  providerId: string | null;
  officeName: string;
  providerName: string;
  providerRole: string;
  /** Six-digit code patients enter during mobile onboarding to link here. */
  providerCode: string;
  status: AccountStatus;
  plan: AccountPlan;
  city: string;
  state: string;
  email: string;
  phone: string;
  /** Date key the account joined the program (display only). */
  joinedKey: string;
  /** First-person short name for the scoped Overview greeting. */
  greetingName: string;
  activePatientCount: number;
  newEnrollments: number;
  recurringRevenue: number;
  enrollmentRevenue: number;
  activeSubscriptions: number;
  /** Deliveries inside the default 30-day demo window. */
  deliveriesInWindow: number;
  /** % of patients logging in the companion app each week. */
  engagementRate: number;
  avgPoundsLost: number;
  goalCompletion: number;
  retention: number;
}

export const SEEDED_ACCOUNTS: ProviderAccount[] = [
  {
    id: 'acct-p1',
    providerId: 'p1',
    officeName: 'Jenkins Aesthetics & Wellness',
    providerName: 'Dr. Sarah Jenkins',
    providerRole: 'Medical Director',
    providerCode: '123456',
    status: 'active',
    plan: 'Concierge',
    city: 'Pasadena',
    state: 'CA',
    email: 'frontdesk@jenkinswellness.example.com',
    phone: '(555) 301-4420',
    joinedKey: '2025-10-06',
    greetingName: 'Dr. Jenkins',
    activePatientCount: 142,
    newEnrollments: 19,
    recurringRevenue: 27500,
    enrollmentRevenue: 14000,
    activeSubscriptions: 115,
    deliveriesInWindow: 128,
    engagementRate: 91.2,
    avgPoundsLost: 25.8,
    goalCompletion: 89.0,
    retention: 95.2,
  },
  {
    id: 'acct-p2',
    providerId: 'p2',
    officeName: 'Chen Metabolic Health',
    providerName: 'Michael Chen, NP',
    providerRole: 'Lead Practitioner',
    providerCode: '284119',
    status: 'active',
    plan: 'Plus',
    city: 'Austin',
    state: 'TX',
    email: 'care@chenmetabolic.example.com',
    phone: '(555) 442-8103',
    joinedKey: '2025-12-01',
    greetingName: 'Michael',
    activePatientCount: 185,
    newEnrollments: 25,
    recurringRevenue: 35800,
    enrollmentRevenue: 18100,
    activeSubscriptions: 150,
    deliveriesInWindow: 167,
    engagementRate: 92.5,
    avgPoundsLost: 26.1,
    goalCompletion: 92.4,
    retention: 96.0,
  },
  {
    id: 'acct-p3',
    providerId: 'p3',
    officeName: 'Rostova Wellness Collective',
    providerName: 'Elena Rostova, RN',
    providerRole: 'Protocol Coach',
    providerCode: '590233',
    status: 'active',
    plan: 'Plus',
    city: 'Miami',
    state: 'FL',
    email: 'team@rostovawellness.example.com',
    phone: '(555) 218-7745',
    joinedKey: '2026-01-19',
    greetingName: 'Elena',
    activePatientCount: 210,
    newEnrollments: 28,
    recurringRevenue: 40600,
    enrollmentRevenue: 20700,
    activeSubscriptions: 170,
    deliveriesInWindow: 189,
    engagementRate: 87.4,
    avgPoundsLost: 23.2,
    goalCompletion: 86.0,
    retention: 93.4,
  },
  {
    id: 'acct-p4',
    providerId: 'p4',
    officeName: 'Kim Vitality Clinic',
    providerName: 'David Kim, NP',
    providerRole: 'Practitioner',
    providerCode: '617482',
    status: 'active',
    plan: 'Core',
    city: 'Seattle',
    state: 'WA',
    email: 'hello@kimvitality.example.com',
    phone: '(555) 674-2291',
    joinedKey: '2026-03-09',
    greetingName: 'David',
    activePatientCount: 95,
    newEnrollments: 12,
    recurringRevenue: 18300,
    enrollmentRevenue: 9200,
    activeSubscriptions: 77,
    deliveriesInWindow: 88,
    engagementRate: 85.9,
    avgPoundsLost: 22.3,
    goalCompletion: 83.6,
    retention: 92.9,
  },
];

/** Codes handed to session-added accounts, in order; distinct from seeded codes. */
export const NEW_ACCOUNT_CODE_POOL = ['905117', '338420', '771264', '462901', '584736', '219845'];

export const monthlyRevenueOf = (account: ProviderAccount) =>
  account.recurringRevenue + account.enrollmentRevenue;

export const findSeededAccount = (id: string | undefined) =>
  SEEDED_ACCOUNTS.find((account) => account.id === id);

// ---------------------------------------------------------------------------
// Per-account MOCK_ANALYTICS variants (drive the scoped office Overview)
// ---------------------------------------------------------------------------

type Analytics = typeof MOCK_ANALYTICS;

/**
 * Protocol-stage split. Each column sums to the program-wide stage count and
 * each row sums to the account's active patients — so the scoped stage bars
 * and the office demo's bars describe the same 632 people.
 *
 *            wk1 wk2 wk3 wk4 wk5 wk6 maint  total
 *   acct-p1    9   9  10   7   7   8    92    142
 *   acct-p2   12  11  13   9   8  10   122    185
 *   acct-p3   14  12  15  10  10  12   137    210
 *   acct-p4    7   6   7   5   4   5    61     95
 *   program   42  38  45  31  29  35   412    632
 */
const STAGE_SPLITS: Record<string, Analytics['stageCounts']> = {
  'acct-p1': { week1: 9, week2: 9, week3: 10, week4: 7, week5: 7, week6: 8, maintenance: 92 },
  'acct-p2': { week1: 12, week2: 11, week3: 13, week4: 9, week5: 8, week6: 10, maintenance: 122 },
  'acct-p3': { week1: 14, week2: 12, week3: 15, week4: 10, week5: 10, week6: 12, maintenance: 137 },
  'acct-p4': { week1: 7, week2: 6, week3: 7, week4: 5, week5: 4, week6: 5, maintenance: 61 },
};

/** Cohort pounds-lost factor per account (retention shifts by a whole point). */
const COHORT_VARIANTS: Record<string, { lostFactor: number; retentionOffset: number }> = {
  'acct-p1': { lostFactor: 1.05, retentionOffset: 1 },
  'acct-p2': { lostFactor: 1.06, retentionOffset: 1 },
  'acct-p3': { lostFactor: 0.95, retentionOffset: -1 },
  'acct-p4': { lostFactor: 0.91, retentionOffset: -2 },
};

/** Metric change badges for the scoped Overview (program view keeps its own). */
export const ACCOUNT_CHANGE_BADGES: Record<string, { mrr: string; patients: string; avgLost: string }> = {
  'acct-p1': { mrr: '+11.8%', patients: '+7.9%', avgLost: '+2.8%' },
  'acct-p2': { mrr: '+13.1%', patients: '+9.4%', avgLost: '+3.5%' },
  'acct-p3': { mrr: '+12.6%', patients: '+8.8%', avgLost: '+2.6%' },
  'acct-p4': { mrr: '+10.9%', patients: '+7.2%', avgLost: '+2.4%' },
};

const EMPTY_STAGES: Analytics['stageCounts'] = {
  week1: 0, week2: 0, week3: 0, week4: 0, week5: 0, week6: 0, maintenance: 0,
};

const clampPercent = (value: number) => Math.min(99, Math.max(0, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * MOCK_ANALYTICS reshaped for one account. Session-added accounts (no seeded
 * split) get an all-zero shape — their drill-in is disabled until patients
 * enroll, so this is a safety net, not a rendered state.
 */
export function getAccountAnalytics(account: ProviderAccount): Analytics {
  const stages = STAGE_SPLITS[account.id];
  const cohort = COHORT_VARIANTS[account.id];
  if (!stages || !cohort) {
    return {
      monthlyRevenue: 0,
      enrollmentRevenue: 0,
      recurringRevenue: 0,
      activePatients: account.activePatientCount,
      newEnrollments: account.newEnrollments,
      averagePoundsLost: 0,
      averageGoalCompletion: 0,
      retention: 0,
      cohortOutcomes: [],
      stageCounts: EMPTY_STAGES,
    };
  }
  return {
    monthlyRevenue: monthlyRevenueOf(account),
    enrollmentRevenue: account.enrollmentRevenue,
    recurringRevenue: account.recurringRevenue,
    activePatients: account.activePatientCount,
    newEnrollments: account.newEnrollments,
    averagePoundsLost: account.avgPoundsLost,
    averageGoalCompletion: account.goalCompletion,
    retention: account.retention,
    cohortOutcomes: MOCK_ANALYTICS.cohortOutcomes.map((row) => ({
      month: row.month,
      avgLost: round1(row.avgLost * cohort.lostFactor),
      retention: Math.round(clampPercent(row.retention + cohort.retentionOffset)),
    })),
    stageCounts: stages,
  };
}

// ---------------------------------------------------------------------------
// Per-account daily revenue (drives the scoped Overview trend chart)
// ---------------------------------------------------------------------------

/**
 * Splits one demo day's program revenue across the seeded accounts by their
 * monthly-revenue share, using largest-remainder rounding so the four account
 * values always sum exactly to the program day. Any window an admin selects
 * therefore totals ≈ the account's share of the program window (the default
 * window lands on the account's monthly revenue), and adding the four scoped
 * charts back together reproduces the office demo's chart to the dollar.
 */
export function getAccountDailyRevenue(dateKey: string, accountId: string): number {
  const dayTotal = getDailyRevenue(dateKey);
  const shares = SEEDED_ACCOUNTS.map((account) => {
    const ideal = (dayTotal * monthlyRevenueOf(account)) / MOCK_ANALYTICS.monthlyRevenue;
    return { id: account.id, floor: Math.floor(ideal), remainder: ideal - Math.floor(ideal) };
  });
  let leftover = dayTotal - shares.reduce((sum, share) => sum + share.floor, 0);
  // Deterministic distribution: biggest remainder first, seeded order breaks ties.
  const order = [...shares].sort((a, b) => b.remainder - a.remainder);
  for (const share of order) {
    if (leftover <= 0) break;
    share.floor += 1;
    leftover -= 1;
  }
  return shares.find((share) => share.id === accountId)?.floor ?? 0;
}
