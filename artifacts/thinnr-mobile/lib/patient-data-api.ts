/**
 * Client for the live per-patient diary rail (/api/patient-data/* on the API
 * server) plus the whoami lookup that decides real-account mode. Real
 * accounts only — the demo persona never touches these endpoints.
 *
 * Every call sends the patient's current Supabase access token as a bearer
 * header; the server resolves it to a patients row and scopes every read and
 * write to that patient. Failures are explicit: callers receive a
 * PatientDataError carrying plain words fit for the sync snackbar, never a
 * silent fallback.
 */
import type {
  DailyTargets,
  IngredientAdjustment,
  MealLogEntry,
} from '@/data/patient-data';
import type { PatientDataApi, PatientServerState } from '@/context/PatientAccountContext';
import { apiBase } from '@/lib/coach-api';
import { supabase } from '@/lib/supabase';

export class PatientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatientDataError';
  }
}

const NETWORK_MESSAGE = 'Couldn’t reach the server. Check your connection and try again.';
const MALFORMED_MESSAGE = 'The server sent something unexpected. Please try again.';
const SIGNED_OUT_MESSAGE = 'You’re signed out. Sign in again to sync your diary.';

const REQUEST_TIMEOUT_MS = 15_000;

async function authedRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new PatientDataError('This build isn’t configured to reach the server.');
  }
  if (!supabase) {
    throw new PatientDataError('Sign-in isn’t configured in this build.');
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new PatientDataError(SIGNED_OUT_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new PatientDataError(NETWORK_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = (json as { error?: unknown } | null)?.error;
    throw new PatientDataError(
      typeof message === 'string' && message.length > 0
        ? message
        : 'The server couldn’t handle that. Please try again.',
    );
  }
  return json;
}

// ── Account resolution ───────────────────────────────────────────────────────

export type AccountRole = { kind: 'patient'; patientId: string } | { kind: 'other' };

/**
 * Resolves the signed-in session to an account kind via the claim flow's
 * whoami. Staff and demo-profile sessions come back 'other' (they browse the
 * seeded demo persona); only a linked patient row unlocks the live diary.
 */
export async function fetchAccountRole(): Promise<AccountRole> {
  const json = await authedRequest('GET', '/claim/whoami');
  const record = (json ?? {}) as Record<string, unknown>;
  if (record.kind === 'patient') {
    const patientId = record.patientId;
    if (typeof patientId === 'string' && patientId.length > 0) {
      return { kind: 'patient', patientId };
    }
    // A patient without an id is a contract break — treat it as an outage
    // rather than quietly dropping into demo data.
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  return { kind: 'other' };
}

// ── Live diary rail ──────────────────────────────────────────────────────────

const MEALS = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);
const KINDS = new Set(['food', 'recipe', 'quick']);

function parseEntry(raw: unknown): MealLogEntry {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== 'string' ||
    typeof e.dateKey !== 'string' ||
    typeof e.meal !== 'string' ||
    !MEALS.has(e.meal) ||
    typeof e.kind !== 'string' ||
    !KINDS.has(e.kind) ||
    typeof e.name !== 'string' ||
    typeof e.quantity !== 'number' ||
    typeof e.calories !== 'number' ||
    typeof e.protein !== 'number' ||
    typeof e.carbs !== 'number' ||
    typeof e.fat !== 'number'
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const entry: MealLogEntry = {
    id: e.id,
    dateKey: e.dateKey,
    meal: e.meal as MealLogEntry['meal'],
    kind: e.kind as MealLogEntry['kind'],
    name: e.name,
    detail: typeof e.detail === 'string' ? e.detail : '',
    quantity: e.quantity,
    calories: e.calories,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,
  };
  if (typeof e.refId === 'string' && e.refId.length > 0) entry.refId = e.refId;
  if (Array.isArray(e.adjustments)) {
    const adjustments: IngredientAdjustment[] = [];
    let valid = true;
    for (const item of e.adjustments) {
      const adj = item as Record<string, unknown> | null;
      if (
        adj === null ||
        typeof adj !== 'object' ||
        typeof adj.index !== 'number' ||
        typeof adj.amount !== 'number' ||
        typeof adj.unit !== 'string'
      ) {
        valid = false;
        break;
      }
      adjustments.push({ index: adj.index, amount: adj.amount, unit: adj.unit });
    }
    if (valid && adjustments.length > 0) entry.adjustments = adjustments;
  }
  return entry;
}

function parseServerState(json: unknown): PatientServerState {
  if (typeof json !== 'object' || json === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const data = json as Record<string, unknown>;
  if (!Array.isArray(data.entries)) throw new PatientDataError(MALFORMED_MESSAGE);
  const entries = data.entries.map(parseEntry);

  const water: Record<string, number> = {};
  if (data.water !== undefined) {
    if (typeof data.water !== 'object' || data.water === null || Array.isArray(data.water)) {
      throw new PatientDataError(MALFORMED_MESSAGE);
    }
    for (const [key, value] of Object.entries(data.water as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) water[key] = value;
    }
  }

  const targets: Partial<DailyTargets> = {};
  if (data.targets !== undefined) {
    if (typeof data.targets !== 'object' || data.targets === null || Array.isArray(data.targets)) {
      throw new PatientDataError(MALFORMED_MESSAGE);
    }
    const t = data.targets as Record<string, unknown>;
    for (const key of ['calories', 'protein', 'carbs', 'fat', 'waterOz'] as const) {
      const value = t[key];
      if (typeof value === 'number' && Number.isFinite(value)) targets[key] = value;
    }
  }

  const favorites = Array.isArray(data.favorites)
    ? data.favorites.filter((v): v is string => typeof v === 'string')
    : [];
  const recents = Array.isArray(data.recents)
    ? data.recents.filter((v): v is string => typeof v === 'string')
    : [];

  return { entries, water, targets, favorites, recents };
}

export const patientDataApi: PatientDataApi = {
  async fetchState(fromKey: string, toKey: string): Promise<PatientServerState> {
    const json = await authedRequest(
      'GET',
      `/patient-data/state?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}`,
    );
    return parseServerState(json);
  },

  async writeEntries(input: {
    upsert?: MealLogEntry[];
    deleteIds?: string[];
    recents?: string[];
  }): Promise<void> {
    await authedRequest('POST', '/patient-data/entries', input);
  },

  async writeWater(dateKey: string, oz: number): Promise<void> {
    await authedRequest('PUT', '/patient-data/water', { dateKey, oz });
  },

  async writeTargets(partial: Partial<DailyTargets>): Promise<void> {
    await authedRequest('PUT', '/patient-data/targets', partial);
  },

  async writePrefs(prefs: { favorites?: string[]; recents?: string[] }): Promise<void> {
    await authedRequest('PUT', '/patient-data/prefs', prefs);
  },
};
