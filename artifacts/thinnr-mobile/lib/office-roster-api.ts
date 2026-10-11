/**
 * Client for the office live roster + patient invitation endpoints
 * (/api/office/* on the API server). Staff accounts only — nothing here runs
 * while signed out, and the office is ALWAYS derived from the
 * signed-in staff member's bearer token on the server; this client never
 * names one.
 *
 * Failures are explicit OfficeRosterErrors carrying the server's own words
 * (plus the field they belong to for form errors), never silent fallbacks.
 */
import { apiBase } from '@/lib/coach-api';
import { supabase } from '@/lib/supabase';

const NOT_CONFIGURED = 'Live rosters aren’t configured in this environment.';
const SIGNED_OUT = 'Sign in with your office account to manage patients.';
const NETWORK_ERROR = 'Couldn’t reach the roster service. Check your connection and try again.';
const SESSION_CHANGED = 'Your office session changed. Reload the screen to continue.';

export class OfficeRosterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null = null,
    /** Machine-readable cause from the server (`reason` on the error body) when it sent one. */
    readonly reason: string | null = null,
    /** Billing routes use `code` for machine-readable conflicts. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'OfficeRosterError';
  }
}

/**
 * Roster diet facts (read-only on the provider app). Three-way model:
 *  - the whole object null → the diet family could not be read (unknown);
 *  - `diet` null → a real "no diet chosen";
 *  - `fitsDietPct` null → unknown (no scored foods yet), never 0.
 */
export interface RosterDietFacts {
  diet: { slug: string; name: string; startedAt: string | null } | null;
  pendingBlock: { id: string; createdAt: string | null } | null;
  severeAllergy: boolean;
  fitsDietPct: number | null;
  fitsDietSample: number;
  fitWindowDays: number;
}

export interface OfficePatient {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  activationStatus: string | null;
  verified: boolean;
  createdAt: string | null;
  closure?: { closedAt: string; recordRetainUntil: string } | null;
  program?: { stage?: 'protocol' | 'maintenance' | null; week?: number } | null;
  diet?: RosterDietFacts | null;
  invitation: {
    state: 'pending' | 'verified';
    invitedAt: string;
    emailStatus: 'pending' | 'sent' | 'failed';
    emailUpdatedAt: string | null;
  } | null;
}

export interface OfficeRosterData {
  office: { providerId: string; officeName: string; providerCode: string };
  patients: OfficePatient[];
}

export interface InvitePatientInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export type InvitationEmailOutcome = 'sent' | 'failed' | 'not_configured';

export interface OfficeRequestScope {
  userId: string;
  signal?: AbortSignal;
  /** Extra request headers (an Idempotency-Key on money writes). */
  headers?: Record<string, string>;
  /** Fallback error copy when the server sends no message ("The payments request failed"). */
  failedMessage?: string;
}

export type OfficeRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function officeBearerRequest<T>(method: OfficeRequestMethod, path: string, body?: unknown, scope?: OfficeRequestScope): Promise<T> {
  if (!supabase) throw new OfficeRosterError(NOT_CONFIGURED, 503);
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new OfficeRosterError(NOT_CONFIGURED, 503);
  }
  const { data } = await supabase.auth.getSession();
  if (scope && (data.session?.user?.id !== scope.userId || scope.signal?.aborted)) {
    throw new OfficeRosterError(SESSION_CHANGED, 401);
  }
  let token = data.session?.access_token;
  if (!token) throw new OfficeRosterError(SIGNED_OUT, 401);

  const perform = async (accessToken: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...scope?.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: scope?.signal,
    });

  let response: Response;
  try {
    response = await perform(token);
    if (response.status === 401) {
      // Never refresh an old query under the account that replaced it. React
      // Query's cache key is identity-scoped, so every retry must be too.
      if (scope) {
        const current = await supabase.auth.getSession();
        if (scope.signal?.aborted || current.data.session?.user?.id !== scope.userId) {
          throw new OfficeRosterError(SESSION_CHANGED, 401);
        }
      }
      const refreshed = await supabase.auth.refreshSession();
      const refreshedToken = refreshed.data.session?.access_token;
      if (refreshedToken) {
        if (scope && (scope.signal?.aborted || refreshed.data.session?.user?.id !== scope.userId)) {
          throw new OfficeRosterError(SESSION_CHANGED, 401);
        }
        token = refreshedToken;
        response = await perform(token);
      }
    }
  } catch (error) {
    if (error instanceof OfficeRosterError) throw error;
    if (scope?.signal?.aborted) throw new OfficeRosterError(SESSION_CHANGED, 401);
    throw new OfficeRosterError(NETWORK_ERROR, 0);
  }
  let json: { error?: unknown; field?: unknown; reason?: unknown; code?: unknown } & Partial<T> = {};
  try {
    json = (await response.json()) as typeof json;
  } catch {
    // Generic message below.
  }
  if (!response.ok) {
    throw new OfficeRosterError(
      typeof json.error === 'string' ? json.error : `${scope?.failedMessage ?? 'The roster request failed'} (${response.status}).`,
      response.status,
      typeof json.field === 'string' ? json.field : null,
      typeof json.reason === 'string' ? json.reason : null,
      typeof json.code === 'string' ? json.code : null,
    );
  }
  const billingScope = response.headers.get('X-Billing-Scope');
  if (billingScope && json && typeof json === 'object') Object.assign(json, { billing_scope: billingScope });
  return json as T;
}

export async function fetchOfficeRoster(scope?: OfficeRequestScope): Promise<OfficeRosterData> {
  return officeBearerRequest<OfficeRosterData>('GET', '/office/roster', undefined, scope);
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export type LeaderboardPeriod = 'program' | '30d' | '90d';
export type LeaderboardMetric = 'percent' | 'pounds' | 'goal' | 'adherence';
export type LeaderboardStage = 'all' | 'protocol' | 'maintenance';

export interface LeaderboardRow {
  id: string;
  providerId: string;
  officeName: string | null;
  name: string;
  initials: string;
  program: { startDate: string | null; day: number | null; stage: 'protocol' | 'maintenance' | null; week: number | null };
  asOfDate: string;
  periodStart: string;
  baselineWeight: number;
  baselineWeightDate: string | null;
  latestWeight: number;
  latestWeightDate: string | null;
  poundsLost: number;
  percentLost: number;
  /** Program-to-date goal completion, 0–100; null without a usable goal. */
  goalCompletion: number | null;
  adherence: {
    score: number | null;
    eligibleDays: number;
    loggedDays: number;
    checkInDays: number;
    waterGoalDays: number;
    loggedRate: number | null;
    checkInRate: number | null;
    waterRate: number | null;
  };
  /** Server-computed competition ranks per metric (ties share a rank). */
  ranks: Record<LeaderboardMetric, number>;
}

export interface OfficeLeaderboardData {
  office: { providerId: string; officeName: string } | null;
  period: LeaderboardPeriod;
  stage: LeaderboardStage;
  asOf: string;
  windowDays: number | null;
  rows: LeaderboardRow[];
  notRankable: { total: number; reasons: Array<{ reason: string; label: string; count: number }> };
  definitions: { adherence: string; loss: string; goal: string; eligibility: string; ties: string };
}

/**
 * Live ranking for the signed-in staff member's office. Ranks, adherence,
 * and eligibility are all server-computed; the client only chooses which
 * server rank to sort by. The office is never named here.
 */
export async function fetchOfficeLeaderboard(params: {
  period: LeaderboardPeriod;
  stage: LeaderboardStage;
}, scope?: OfficeRequestScope): Promise<OfficeLeaderboardData> {
  const query = new URLSearchParams({ period: params.period, stage: params.stage });
  return officeBearerRequest<OfficeLeaderboardData>('GET', `/office/leaderboard?${query.toString()}`, undefined, scope);
}

export async function invitePatient(
  input: InvitePatientInput,
): Promise<{ patient: OfficePatient; invitation: InvitationEmailOutcome }> {
  return officeBearerRequest('POST', '/office/invitations', input);
}

export async function resendInvitation(
  patientId: string,
): Promise<{ ok: boolean; invitation: InvitationEmailOutcome; patient: OfficePatient }> {
  return officeBearerRequest('POST', `/office/invitations/${encodeURIComponent(patientId)}/resend`, {});
}

/**
 * Shared US phone formatting — the same 10-digit rule (optional leading 1)
 * the server enforces, rendered as (xxx) xxx-xxxx while typing. Mirrors the
 * desktop portal so both invite forms behave identically.
 */
export function formatUsPhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function usPhoneDigits(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field-keyed validation shared with the desktop invite form; mirrors the API rules. */
export function validateInviteForm(
  input: InvitePatientInput,
): Partial<Record<keyof InvitePatientInput, string>> {
  const errors: Partial<Record<keyof InvitePatientInput, string>> = {};
  if (!input.firstName.trim()) errors.firstName = 'First name is required.';
  else if (input.firstName.trim().length > 80) errors.firstName = 'First name is too long.';
  if (!input.lastName.trim()) errors.lastName = 'Last name is required.';
  else if (input.lastName.trim().length > 80) errors.lastName = 'Last name is too long.';
  if (!input.email.trim()) errors.email = 'Email is required.';
  else if (!EMAIL_PATTERN.test(input.email.trim())) errors.email = 'Enter a valid email address.';
  if (!input.phone.trim()) errors.phone = 'Phone number is required.';
  else if (!usPhoneDigits(input.phone)) errors.phone = 'Enter a valid 10-digit US mobile number.';
  return errors;
}
