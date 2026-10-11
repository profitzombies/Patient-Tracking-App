/**
 * Office client for one patient's diet program (the foundation routes under
 * /office/patients/:id/diet). Same contract as the other live-record edits:
 * the office is server-derived, an HQ drill-in names it with `?office=`, and
 * every write is audited server-side. The two-step override is deliberately
 * two requests — the challenge from step one must be echoed by step two.
 */
import type {
  DietBlock,
  DietChoiceActive,
  DietChoicePending,
  DietCleared,
  DietOverrideChallenge,
  DietOverrideResult,
  DietPreferenceItem,
  DietScreeningAnswers,
  OfficePatientDiet,
  PreferenceListName,
  ProtocolRestartResult,
} from '@workspace/api-client-react';
import { OfficeApiError, officeAuthToken, officeQuery } from '@/lib/office-api';
import { supabase } from '@/lib/supabase';
import { ReauthRequiredError, withReauthRetry } from '@/lib/reauth';

export type {
  DietBlock,
  DietChoiceActive,
  DietChoicePending,
  DietOverrideChallenge,
  DietOverrideResult,
  DietPreferenceItem,
  DietScreeningAnswers,
  OfficePatientDiet,
  PreferenceListName,
  ProtocolRestartResult,
};

const MESSAGES = {
  unconfigured: 'Diet records are unavailable in this environment.',
  signedOut: 'Sign in again to view this patient’s diet.',
  unreachable: 'The diet record could not be reached. Check your connection and try again.',
  failed: 'The diet request failed',
};

/** Same as OfficeApiError plus the structured extras the diet routes attach (screening questions, lock day). */
export class OfficeDietError extends OfficeApiError {
  constructor(
    message: string,
    status: number,
    field: string | null,
    code: string | null,
    readonly questions: string[] = [],
    readonly reason: string | null = null,
  ) {
    super(message, status, field, code);
    this.name = 'OfficeDietError';
  }
}

async function dietRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let token = await officeAuthToken(MESSAGES.unconfigured, MESSAGES.signedOut);
  const perform = (accessToken: string) => fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
  });
  let response: Response;
  try {
    response = await withReauthRetry(() => perform(token));
    if (response.status === 401 && supabase) {
      const { data } = await supabase.auth.refreshSession();
      const refreshed = data.session?.access_token;
      if (refreshed) { token = refreshed; response = await withReauthRetry(() => perform(token)); }
    }
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    throw new OfficeDietError(MESSAGES.unreachable, 0, null, null);
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* generic message below */ }
  if (!response.ok) {
    throw new OfficeDietError(
      typeof body.error === 'string' ? body.error : `${MESSAGES.failed} (${response.status}).`,
      response.status,
      typeof body.field === 'string' ? body.field : null,
      typeof body.code === 'string' ? body.code : null,
      Array.isArray(body.questions) ? body.questions.filter((q): q is string => typeof q === 'string') : [],
      typeof body.reason === 'string' ? body.reason : null,
    );
  }
  return body as T;
}

function patientPath(patientId: string, suffix: string, office: string | null | undefined): string {
  return `/api/office/patients/${encodeURIComponent(patientId)}${suffix}${officeQuery(office)}`;
}

export function officeDietQueryKey(office: string | null | undefined, patientId: string) {
  return ['office-patient-diet', office ?? 'own', patientId] as const;
}

export async function fetchOfficePatientDiet(patientId: string, office?: string | null): Promise<OfficePatientDiet> {
  const payload = await dietRequest<OfficePatientDiet>(patientPath(patientId, '/diet', office));
  if (!payload || typeof payload !== 'object' || !payload.phase || !payload.history || !Array.isArray(payload.library) || !Array.isArray(payload.preferences)) {
    throw new OfficeDietError('Diet record returned an unexpected response', 500, null, null);
  }
  return payload;
}

export interface SetDietInput {
  dietSlug: string;
  answers?: DietScreeningAnswers;
}

export type SetDietResult = DietChoiceActive | DietChoicePending;

export function setOfficePatientDiet(patientId: string, office: string | null | undefined, input: SetDietInput): Promise<SetDietResult> {
  return dietRequest<SetDietResult>(patientPath(patientId, '/diet', office), { method: 'PUT', body: JSON.stringify(input) });
}

export function clearOfficePatientDiet(patientId: string, office: string | null | undefined): Promise<DietCleared> {
  return dietRequest<DietCleared>(patientPath(patientId, '/diet', office), { method: 'DELETE' });
}

export function startDietBlockOverride(patientId: string, office: string | null | undefined, blockId: string): Promise<DietOverrideChallenge> {
  return dietRequest<DietOverrideChallenge>(patientPath(patientId, `/diet/blocks/${encodeURIComponent(blockId)}/override`, office), { method: 'POST', body: '{}' });
}

export function confirmDietBlockOverride(
  patientId: string,
  office: string | null | undefined,
  blockId: string,
  input: { challenge: string; note?: string },
): Promise<DietOverrideResult> {
  return dietRequest<DietOverrideResult>(
    patientPath(patientId, `/diet/blocks/${encodeURIComponent(blockId)}/override/confirm`, office),
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function rejectDietBlock(patientId: string, office: string | null | undefined, blockId: string, note?: string): Promise<{ status: 'rejected'; block: DietBlock }> {
  return dietRequest(patientPath(patientId, `/diet/blocks/${encodeURIComponent(blockId)}/reject`, office), { method: 'POST', body: JSON.stringify(note ? { note } : {}) });
}

export function restartOfficePatientProtocol(patientId: string, office: string | null | undefined, input: { startedOn?: string; note?: string }): Promise<ProtocolRestartResult> {
  return dietRequest<ProtocolRestartResult>(patientPath(patientId, '/protocol/restart', office), { method: 'POST', body: JSON.stringify(input) });
}

export interface PreferenceItemInput {
  list: PreferenceListName;
  key?: string;
  label?: string;
  severity?: 'mild' | 'severe';
}

export function addOfficePatientPreference(patientId: string, office: string | null | undefined, input: PreferenceItemInput): Promise<{ item: DietPreferenceItem }> {
  return dietRequest(patientPath(patientId, '/diet/preferences', office), { method: 'POST', body: JSON.stringify(input) });
}

export function removeOfficePatientPreference(patientId: string, office: string | null | undefined, itemId: string): Promise<{ ok: true }> {
  return dietRequest(patientPath(patientId, `/diet/preferences/${encodeURIComponent(itemId)}`, office), { method: 'DELETE' });
}
