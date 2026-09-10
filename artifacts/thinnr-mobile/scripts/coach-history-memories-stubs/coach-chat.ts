export type Conversation = {
  id: string; title: string; updatedAt: string; processingState: "ready" | "failed";
  createdAt: string; version: number; titleState: "ready"; archivedAt: string | null;
};
export const coachState: {
  list: (archived: boolean, offset: number) => Promise<{ conversations: Conversation[]; nextOffset: number | null }>;
  start: () => void;
  select: (id: string) => Promise<void>;
  archive: (conversation: Conversation, archived: boolean) => Promise<void>;
} = {
  list: async () => ({ conversations: [], nextOffset: null }),
  start: () => {},
  select: async () => {},
  archive: async () => {},
};
export const useCoachChat = () => ({
  startNewConversation: coachState.start,
  selectConversation: coachState.select,
  listConversations: coachState.list,
  setArchived: (conversation: Conversation, archived: boolean) => coachState.archive(conversation, archived),
  loadOlder: async () => {},
});