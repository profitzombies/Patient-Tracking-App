export type CoachMemory = {
  id: string; text: string; category: string; state: "active" | "pending" | "removed" | "declined";
  version: number; sensitivity: "ordinary" | "sensitive"; sourceConversationId: string | null;
  sourceMessageId: string | null; sourceCreatedAt: string | null; createdAt: string; updatedAt: string; confirmedAt: string | null;
};
export type CoachMemoryUpdateInputAction = "approve" | "decline" | "forget" | "correct";
export const apiState: {
  list: (params: { offset?: number; limit?: number }, options?: { headers?: Record<string, string> }) => Promise<{ memories: CoachMemory[]; nextOffset: number | null }>;
  update: (id: string, data: { action: CoachMemoryUpdateInputAction; expectedVersion: number; text?: string }, options?: { headers?: Record<string, string> }) => Promise<{ memory: CoachMemory }>;
  retry: (id: string, options?: { headers?: Record<string, string> }) => Promise<{ ok: true }>;
} = {
  list: async () => ({ memories: [], nextOffset: null }),
  update: async () => { throw new Error("unscripted update"); },
  retry: async () => ({ ok: true }),
};
export const listPatientCoachMemories = (
  params: { offset?: number; limit?: number },
  options?: { headers?: Record<string, string> },
) => apiState.list(params, options);
export const updatePatientCoachMemory = (
  id: string,
  data: { action: CoachMemoryUpdateInputAction; expectedVersion: number; text?: string },
  options?: { headers?: Record<string, string> },
) => apiState.update(id, data, options);
export const retryPatientCoachProcessing = (
  id: string,
  options?: { headers?: Record<string, string> },
) => apiState.retry(id, options);