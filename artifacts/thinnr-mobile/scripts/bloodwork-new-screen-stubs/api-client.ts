export type CreateBehavior =
  | { kind: 'reject'; error: unknown }
  | { kind: 'deferred' }
  | { kind: 'replay' };

export const state: {
  createBehaviors: CreateBehavior[];
  createCalls: Array<{ clientRequestId: string; patientId: string }>;
  deleteCalls: string[];
  deferredReject: ((error: unknown) => void) | null;
  deferredResolve: ((value: { reportId: string; uploads: [] }) => void) | null;
} = {
  createBehaviors: [],
  createCalls: [],
  deleteCalls: [],
  deferredReject: null,
  deferredResolve: null,
};

export function resetApi(): void {
  state.createBehaviors = [];
  state.createCalls = [];
  state.deleteCalls = [];
  state.deferredReject = null;
  state.deferredResolve = null;
}

export async function createBloodworkReport(
  patientId: string,
  body: { clientRequestId: string },
  options?: { signal?: AbortSignal },
): Promise<{ reportId: string; uploads: [] }> {
  state.createCalls.push({ clientRequestId: body.clientRequestId, patientId });
  const behavior = state.createBehaviors.shift() ?? { kind: 'replay' as const };
  if (behavior.kind === 'reject') throw behavior.error;
  if (behavior.kind === 'replay') return { reportId: 'report-replay', uploads: [] };
  return new Promise((resolve, reject) => {
    state.deferredResolve = resolve;
    state.deferredReject = reject;
    options?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Upload cancelled', 'AbortError'));
    }, { once: true });
  });
}

export async function commitBloodworkReport(): Promise<void> {
  return;
}

export async function deleteBloodworkReport(
  _patientId: string,
  reportId: string,
): Promise<void> {
  state.deleteCalls.push(reportId);
}