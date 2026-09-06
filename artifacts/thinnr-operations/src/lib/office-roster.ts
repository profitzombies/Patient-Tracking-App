/**
 * Client for the live office roster + patient invitation endpoints.
 *
 * Scope is server-derived: signed-in provider staff never send an office id
 * (the API resolves their own office from the bearer token), while an HQ
 * drill-in names the office it is explicitly viewing. The demo persona never
 * calls these endpoints at all — the seeded roster stays byte-identical.
 */
import { supabase } from '@/lib/supabase';

export class OfficeRosterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'OfficeRosterError';
  }
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
  /** Optional summary values supplied by the roster endpoint as they become available. */
  status?: string | null;
  providerName?: string | null;
  startDate?: string | null;
  startingWeight?: number | null;
  currentWeight?: number | null;
  goalWeight?: number | null;
  lastLogAt?: string | null;
  loggedDays7?: number | null;
  program?: {
    id: string | null;
    day?: number;
    stage?: 'protocol' | 'maintenance' | null;
    week?: number;
    startDate: string | null;
    startingWeight: number | null;
    currentWeight: number | null;
    goalWeight: number | null;
    weightChange: number | null;
    lastLogDate: string | null;
  };
  invitation: {
    state: 'pending' | 'verified';
    invitedAt: string;
    emailStatus: 'pending' | 'sent' | 'failed';
    emailUpdatedAt: string | null;
  } | null;
  operational?: {
    /** Patient-local calendar day the signals were computed for. */
    asOfDate?: string;
    latestActivityDate: string | null;
    latestDiaryDate: string | null;
    latestWaterDate: string | null;
    latestCheckInDate: string | null;
    latestWeightDate: string | null;
    latestPhotoDate: string | null;
    /** Window counts; null when there is no data of that kind yet or the aggregate is unavailable. */
    loggedDays7: number | null;
    checkIns7: number | null;
    /** Activity signals; null when the office aggregate had no row for the patient (unknown, not zero). */
    activity?: PatientActivitySignals | null;
    /** `unknown` = the aggregate had no row for this patient; never treated as lapsed. */
    status: 'invited' | 'inactive' | 'needs_attention' | 'on_track' | 'unknown';
    reasons: ('logging_lapsed' | 'check_in_overdue' | 'no_activity_14d')[];
    followUps?: {
      reason: 'logging_lapsed' | 'check_in_overdue' | 'no_activity_14d';
      status: 'open' | 'resolved';
      createdAt: string;
      resolvedAt: string | null;
    }[];
  };
}

export type MoodKey = '1' | '2' | '3' | '4' | '5';

/**
 * Activity signals over a patient's stored diary, water and check-in rows.
 * Families are null while there is no data of that kind yet (diary family:
 * loggedLast7/loggedDays7/mealStreak/avgCalories7; check-in family:
 * checkInStreak/checkInRate30/latestCheckInDate/moodCounts/topSideEffects);
 * averages are null when their window holds no qualifying day. Zero is only
 * ever a real zero. The patient detail's `engagement` shares the definition.
 */
export interface PatientActivitySignals {
  asOfDate: string;
  /** Seven booleans, oldest first, ending on asOfDate. */
  loggedLast7: boolean[] | null;
  loggedDays7: number | null;
  mealStreak: number | null;
  avgCalories7: number | null;
  avgWater7: number | null;
  checkInStreak: number | null;
  checkInRate30: number | null;
  latestCheckInDate: string | null;
  moodCounts: Record<MoodKey, number> | null;
  topSideEffects: Array<{ name: string; count: number }> | null;
}

export interface OfficeRosterSummary {
  totalPatients: number;
  activePatients: number;
  newEnrollments30d: number;
  needsAttention: number;
  inactive: number;
  invited: number;
  checkInsOverdue: number;
  loggingLapsed: number;
  asOf: string;
}

export interface OfficeRoster {
  office: { providerId: string; officeName: string; providerCode: string };
  patients: OfficePatient[];
  summary: OfficeRosterSummary;
}

export interface OfficeWeightEntry {
  dateKey: string;
  weight: number;
}

export interface OfficeDiaryEntry {
  id: string;
  dateKey: string;
  meal: string;
  name: string;
  kind: string | null;
  refId?: string;
  detail: string;
  quantity: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  adjustments?: unknown[];
}

export interface OfficeCheckIn {
  id: string;
  dateKey: string;
  mood: number | null;
  weight?: number | null;
  sideEffects?: string[];
  notes: string | null;
}

export interface OfficeProgressPhoto {
  id: string;
  dateKey: string;
  label: string;
  angle: string | null;
  url: string | null;
}

/** Provider-safe detail contract. It intentionally contains no patient login/auth data. */
export interface OfficePatientDetail {
  office: OfficeRoster['office'];
  patient: {
    identity: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      phoneDisplay: string | null;
      activationStatus: string | null;
      verified: boolean;
      dateOfBirth: string | null;
      height: string | null;
      timezone: string | null;
      createdAt: string | null;
      claimedAt: string | null;
      lastLoginAt: string | null;
    };
    program: {
      id: string | null;
      startDate: string | null;
      startingWeight: number | null;
      currentWeight: number | null;
      goalWeight: number | null;
      weightChange: number | null;
      lastLogDate: string | null;
    };
  };
  diary: {
    entries: OfficeDiaryEntry[];
    nutritionTotals: {
      overall: { calories: number; protein: number; carbs: number; fat: number };
      byDate: Array<{ dateKey: string; calories: number; protein: number; carbs: number; fat: number }>;
    };
  };
  water: Array<{ dateKey: string; oz: number }>;
  checkIns: OfficeCheckIn[];
  /** Same definitions as the roster's operational.activity, over the rows above. */
  engagement?: PatientActivitySignals;
  weights: OfficeWeightEntry[];
  progressPhotos: OfficeProgressPhoto[];
  account: {
    targets: { calories: number | null; protein: number | null; carbs: number | null; fat: number | null; waterOz: number | null };
    favorites: unknown[];
    recents: unknown[];
    customFoods: unknown[];
    savedRecipes: unknown[];
    flags: Record<string, unknown>;
  };
}

export interface InvitePatientInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export type InvitationEmailOutcome = 'sent' | 'failed' | 'not_configured';

async function authToken(): Promise<string> {
  if (!supabase) throw new OfficeRosterError('Live rosters are not configured in this environment.', 503);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new OfficeRosterError('Sign in to manage this office’s patients.', 401);
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let token = await authToken();
  let response: Response;
  const perform = (accessToken: string) => fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  try {
    response = await perform(token);
    if (response.status === 401 && supabase) {
      const { data } = await supabase.auth.refreshSession();
      const refreshed = data.session?.access_token;
      if (refreshed) {
        token = refreshed;
        response = await perform(token);
      }
    }
  } catch {
    throw new OfficeRosterError('Could not reach the roster service. Check your connection and try again.', 0);
  }
  let body: { error?: unknown; field?: unknown } & Partial<T> = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Generic message below.
  }
  if (!response.ok) {
    throw new OfficeRosterError(
      typeof body.error === 'string' ? body.error : `The roster request failed (${response.status}).`,
      response.status,
      typeof body.field === 'string' ? body.field : null,
    );
  }
  return body as T;
}

function officeQuery(office?: string | null): string {
  return office ? `?office=${encodeURIComponent(office)}` : '';
}

export async function fetchOfficeRoster(office?: string | null): Promise<OfficeRoster> {
  return request<OfficeRoster>(`/api/office/roster${officeQuery(office)}`);
}

export async function fetchOfficePatient(patientId: string, office?: string | null): Promise<OfficePatientDetail> {
  return request<OfficePatientDetail>(
    `/api/office/patients/${encodeURIComponent(patientId)}${officeQuery(office)}`,
  );
}

export async function invitePatient(
  input: InvitePatientInput,
  office?: string | null,
): Promise<{ patient: OfficePatient; invitation: InvitationEmailOutcome }> {
  return request(`/api/office/invitations`, {
    method: 'POST',
    body: JSON.stringify(office ? { ...input, office } : input),
  });
}

export async function resendInvitation(
  patientId: string,
  office?: string | null,
): Promise<{ ok: boolean; invitation: InvitationEmailOutcome; patient: OfficePatient }> {
  return request(`/api/office/invitations/${encodeURIComponent(patientId)}/resend`, {
    method: 'POST',
    body: JSON.stringify(office ? { office } : {}),
  });
}

/**
 * Shared US phone formatting — the same 10-digit rule (optional leading 1)
 * the server enforces, rendered as (xxx) xxx-xxxx while typing.
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

/** Field-keyed validation shared by the invite form; mirrors the API rules. */
export function validateInviteForm(input: InvitePatientInput): Partial<Record<keyof InvitePatientInput, string>> {
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
