export type Conversation = {
  id: string; title: string; updatedAt: string; processingState: "ready" | "failed";
  createdAt: string; version: number; titleState: "ready"; archivedAt: string | null;
};
export const coachState: {
  list: (archived: boolean, offset: number) => Promise<{ conversations: Conversation[]; nextOffset: number | null }>;
  select: (id: string) => Promise<void>;
  archive: (conversation: Conversation, archived: boolean) => Promise<void>;
} = {
  list: async () => ({ conversations: [], nextOffset: null }),
  select: async () => {},
  archive: async () => {},
};
export const useCoachChat = () => ({
  startNewConversation: () => {},
  selectConversation: coachState.select,
  listConversations: coachState.list,
  setArchived: coachState.archive,
  loadOlder: async () => {},
});