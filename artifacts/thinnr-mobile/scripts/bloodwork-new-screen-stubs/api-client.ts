export type CreateBehavior =
  | { kind: 'reject'; error: unknown }
  | { kind: 'deferred' }
  | { kind: 'upload' }
  | { kind: 'replay' };

export const state: {
  createBehaviors: CreateBehavior[];
  createCalls: Array<{ clientRequestId: string; patientId: string }>;
  deleteCalls: string[];
  deferredReject: ((error: unknown) => void) | null;
  deferredResolve: ((value: { reportId: string; uploads: Array<{ fileId: string; clientFileId: string; uploadUrl: string; expiresAt: string }> }) => void) | null;
  commitDeferred: boolean;
  commitResolve: (() => void) | null;
} = {
  createBehaviors: [],
  createCalls: [],
  deleteCalls: [],
  deferredReject: null,
  deferredResolve: null,
  commitDeferred: false,
  commitResolve: null,
};

export function getListBloodworkReportsQueryKey(patientId: string, params?: Record<string, unknown>) {
  return [`/api/bloodwork/patients/${patientId}/reports`, ...(params ? [params] : [])] as const;
}

export function resetApi(): void {
  state.createBehaviors = [];
  state.createCalls = [];
  state.deleteCalls = [];
  state.deferredReject = null;
  state.deferredResolve = null;
  state.commitDeferred = false;
  state.commitResolve = null;
}

export async function createBloodworkReport(
  patientId: string,
  body: { clientRequestId: string },
  options?: { signal?: AbortSignal },
): Promise<{ reportId: string; uploads: Array<{ fileId: string; clientFileId: string; uploadUrl: string; expiresAt: string }> }> {
  state.createCalls.push({ clientRequestId: body.clientRequestId, patientId });
  const behavior = state.createBehaviors.shift() ?? { kind: 'replay' as const };
  if (behavior.kind === 'reject') throw behavior.error;
  if (behavior.kind === 'replay') return { reportId: 'report-replay', uploads: [] };
  if (behavior.kind === 'upload') {
    return {
      reportId: 'report-upload',
      uploads: [{
        fileId: 'file-upload',
        clientFileId: 'file-a',
        uploadUrl: 'https://storage.example.test/upload',
        expiresAt: '2026-09-10T13:00:00Z',
      }],
    };
  }
  return new Promise((resolve, reject) => {
    state.deferredResolve = resolve;
    state.deferredReject = reject;
    options?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Upload cancelled', 'AbortError'));
    }, { once: true });
  });
}

export async function commitBloodworkReport(): Promise<void> {
  if (state.commitDeferred) {
    await new Promise<void>(resolve => {
      state.commitResolve = resolve;
    });
  }
}

export async function deleteBloodworkReport(
  _patientId: string,
  reportId: string,
): Promise<void> {
  state.deleteCalls.push(reportId);
}