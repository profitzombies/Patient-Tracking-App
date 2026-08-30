/** Live provider-account shapes shared by HQ screens and scope helpers. */
import { MOCK_ANALYTICS } from '../mock-data';

export type AccountStatus = 'active' | 'needs_setup' | 'locked';
export type AccountPlan = 'Core' | 'Plus' | 'Concierge';

export interface ProviderAccount {
  id: string;
  providerId: string;
  officeName: string;
  providerName: string;
  providerRole: string;
  providerCode: string | null;
  status: AccountStatus;
  plan: AccountPlan | null;
  city: string;
  state: string;
  email: string;
  phone: string | null;
  joinedKey: string;
  greetingName: string;
  /** Omitted by Support's contact-only provider directory DTO. */
  activePatientCount: number | null;
  newEnrollments: number | null;
  recurringRevenue: number | null;
  enrollmentRevenue: number | null;
  activeSubscriptions: number | null;
  deliveriesInWindow: number | null;
  engagementRate: number | null;
  avgPoundsLost: number | null;
  goalCompletion: number | null;
  retention: number | null;
}

export interface ProviderPatient {
  id: string;
  name: string;
  email: string;
  status: string;
}

export interface ProviderStaffMember {
  id: string;
  name: string;
  email: string;
  activationStatus: string | null;
  authUserId: string | null;
  claimedAt: string | null;
}

export interface ProviderAccountDetail {
  account: ProviderAccount;
  roster: ProviderPatient[];
  staff: ProviderStaffMember[];
}

export const monthlyRevenueOf = (account: ProviderAccount): number | null => {
  if (account.recurringRevenue == null || account.enrollmentRevenue == null) return null;
  return account.recurringRevenue + account.enrollmentRevenue;
};

/** Legacy office analytics have no authoritative live provider-account source. */
export function getAccountAnalytics(account: ProviderAccount): typeof MOCK_ANALYTICS {
  return {
    monthlyRevenue: 0,
    enrollmentRevenue: 0,
    recurringRevenue: 0,
    activePatients: account.activePatientCount ?? 0,
    newEnrollments: 0,
    averagePoundsLost: 0,
    averageGoalCompletion: 0,
    retention: 0,
    cohortOutcomes: [],
    stageCounts: { week1: 0, week2: 0, week3: 0, week4: 0, week5: 0, week6: 0, maintenance: 0 },
  };
}

export function getAccountDailyRevenue(_dateKey?: string, _accountId?: string): number {
  return 0;
}

/** Kept for older non-HQ labels; live account identity is resolved by the API. */
export const ACCOUNT_CHANGE_BADGES: Record<string, { mrr: string; patients: string; avgLost: string }> = {};

export function findSeededAccount(_id?: string): ProviderAccount | undefined {
  return undefined;
}