export const state = {
  messages: [] as Array<{ id: string; role: string; status: string; text: string }>,
  isStreaming: false,
  pendingStage: null,
  selectedConversation: null as { archivedAt: string | null } | null,
  conversationScopeKey: "account:epoch-1:thread-a",
  conversationError: null as string | null,
  isConversationLoading: true,
  isConversationRefreshing: false,
  hasConversationLoaded: false,
  hasOlderMessages: false,
  isLoadingOlder: false,
  coachPaused: null,
  refreshCalls: [] as Array<boolean | undefined>,
  sendCalls: [] as string[],
};
export const useCoachChat = () => ({
  ...state,
  refreshThread,
  send: (text: string) => state.sendCalls.push(text),
  sendPhoto: () => {},
  stop: () => {},
  retry: () => {},
  startNewConversation: () => {},
  loadOlder: async () => {},
});
async function refreshThread(force?: boolean) { state.refreshCalls.push(force); }
export const offersMealPhotoRetake = () => false;