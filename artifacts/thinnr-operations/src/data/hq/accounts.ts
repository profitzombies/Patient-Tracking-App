/**
 * Live provider-account shapes shared by HQ screens and scope helpers, plus
 * the pure, node-testable directory search matcher the All-accounts table
 * uses. The matcher mirrors the conversations rail search: case-insensitive,
 * punctuation-tolerant (digit tokens match phones, codes, and ZIPs however
 * either side is formatted), with every whitespace token required to hit
 * somewhere across the account's displayed values.
 */
import { MOCK_ANALYTICS } from '../mock-data';
import { formatDateKey } from '../nutrition-data';
import { usStateName } from '../../lib/us-contact';

export type AccountStatus = 'active' | 'needs_setup' | 'locked' | 'offboarding' | 'offboarded';
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
  address1: string | null;
  address2: string | null;
  city: string;
  state: string;
  postalCode: string | null;
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
  offboarding: {
    status: 'active' | 'offboarding' | 'offboarded';
    startedAt: string | null;
    offboardedAt: string | null;
  } | null;
  /** The dedicated App Review office store reviewers sign in to: not a customer. */
  appReview: boolean;
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

// ─── Directory search ────────────────────────────────────────────────────────

/** The user-facing chip wording for each account status (AccountStatusChip). */
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  active: 'Active',
  needs_setup: 'Needs setup',
  locked: 'Disabled',
  offboarding: 'Offboarding',
  offboarded: 'Offboarded',
};

const digitsOf = (value: string) => value.replace(/\D+/g, '');
const fmtNumber = (value: number) => value.toLocaleString('en-US');

/** Precomputed search corpus for one account (build once, match per keystroke). */
export interface AccountSearchHaystack {
  /** Lowercased join of every displayed text value (raw + formatted variants). */
  text: string;
  /**
   * Space-joined digit runs of phone, provider code, and ZIP — space-joined
   * so a digit token can never falsely match across two fields.
   */
  digits: string;
}

/**
 * Everything the All-accounts table displays for one account, searchable:
 * office, provider name and role, code, plan, status wording, email, phone,
 * full address (both lines, city, state abbreviation and full name, ZIP),
 * joined date, patient count, and monthly revenue (raw and $-formatted).
 */
export function accountSearchHaystack(
  account: ProviderAccount,
  options?: { locked?: boolean },
): AccountSearchHaystack {
  const revenue = monthlyRevenueOf(account);
  const text = [
    account.officeName,
    account.providerName,
    account.providerRole,
    account.providerCode,
    account.plan,
    ACCOUNT_STATUS_LABEL[account.status],
    // Accounts locked through the HQ kill switch wear an extra "Locked"
    // chip in the table (separate from the persisted status, whose locked
    // label is "Disabled") — that visible wording must be searchable too.
    options?.locked ? 'Locked' : null,
    account.email,
    account.phone,
    account.address1,
    account.address2,
    account.city,
    account.state,
    account.state ? usStateName(account.state) : null,
    account.postalCode,
    formatDateKey(account.joinedKey, true),
    account.activePatientCount == null ? null : `${account.activePatientCount} ${fmtNumber(account.activePatientCount)}`,
    revenue == null ? null : `${revenue} $${fmtNumber(revenue)}`,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const digits = [account.phone, account.providerCode, account.postalCode]
    .map((value) => digitsOf(value ?? ''))
    .filter(Boolean)
    .join(' ');
  return { text, digits };
}

/**
 * Case-insensitive, format-tolerant directory search. Every whitespace token
 * must hit either the text corpus or — for tokens carrying digits — the digit
 * corpus, so "(555) 301" finds the office whose phone is 555-301-4420 however
 * either side is formatted, and "482-115" finds provider code 482115. Tokens
 * may land in different fields ("brooks boston" matches provider + city).
 * An empty query matches everything.
 */
export function accountMatchesQuery(haystack: AccountSearchHaystack, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => {
    if (haystack.text.includes(token)) return true;
    const tokenDigits = digitsOf(token);
    return tokenDigits.length > 0 && haystack.digits.includes(tokenDigits);
  });
}

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