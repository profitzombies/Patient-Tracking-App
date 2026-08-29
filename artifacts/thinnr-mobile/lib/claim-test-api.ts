import { apiBase } from '@/lib/coach-api';
import type { ClaimTestScenario } from '@/lib/claim-test-handoff';

export interface ClaimTestState {
  patient: { name: string; emailMasked: string | null; phoneMasked: string | null };
  state: { claimed: boolean; hasPhone: boolean; hasEmail: boolean };
}

export interface PreparedClaimTest {
  prepared: true;
  scenario: ClaimTestScenario;
  identifier: string;
  mode: 'create' | 'reset';
}

export async function claimTestRequest(
  token: string,
  scenario?: ClaimTestScenario,
): Promise<{ status: number; data: ClaimTestState | PreparedClaimTest | null }> {
  const response = await fetch(`${apiBase()}/claim/test-state`, {
    method: scenario ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: scenario ? JSON.stringify({ scenario }) : undefined,
  });
  let data: ClaimTestState | PreparedClaimTest | null = null;
  try {
    data = (await response.json()) as ClaimTestState | PreparedClaimTest;
  } catch {
    data = null;
  }
  return { status: response.status, data };
}