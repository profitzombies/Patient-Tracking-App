export type Conversation = {
  id: string; title: string; updatedAt: string; processingState: "ready" | "failed";
  createdAt: string; version: number; titleState: "ready"; archivedAt: string | null;
};
export const coachState: {
  accessDeniedError: string | null;
  cached: (archived: boolean) => { conversations: Conversation[]; nextOffset: number | null } | undefined;
  list: (archived: boolean, offset: number) => Promise<{ conversations: Conversation[]; nextOffset: number | null }>;
  start: () => void;
  select: (id: string) => Promise<void>;
  archive: (conversation: Conversation, archived: boolean) => Promise<void>;
} = {
  accessDeniedError: null,
  cached: () => undefined,
  list: async () => ({ conversations: [], nextOffset: null }),
  start: () => {},
  select: async () => {},
  archive: async () => {},
};
export const useCoachChat = () => ({
  accessDeniedError: coachState.accessDeniedError,
  getCachedConversations: coachState.cached,
  startNewConversation: coachState.start,
  selectConversation: (id: string) => coachState.select(id),
  listConversations: coachState.list,
  setArchived: (conversation: Conversation, archived: boolean) => coachState.archive(conversation, archived),
  loadOlder: async () => {},
});