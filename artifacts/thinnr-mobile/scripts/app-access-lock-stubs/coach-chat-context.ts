/**
 * Node stand-in for @/context/CoachChatContext for the app-access lock
 * suite: the tab bar reads the HQ pause (precedence over the lock) and the
 * meal-photo flow reads sendPhoto / isStreaming / coachPaused. The pause is
 * scriptable so the suite can prove "paused wins over locked" without
 * driving the real provider's probe.
 */
export const coachState: { coachPaused: { message: string } | null; isStreaming: boolean } = {
  coachPaused: null,
  isStreaming: false,
};

export const sendPhotoCalls: Array<{ uri: string; kind: string }> = [];
export const startNewConversationCalls = { count: 0 };

export function resetCoachStub(): void {
  coachState.coachPaused = null;
  coachState.isStreaming = false;
  sendPhotoCalls.length = 0;
  startNewConversationCalls.count = 0;
}

export function useCoachChat() {
  return {
    coachPaused: coachState.coachPaused,
    isStreaming: coachState.isStreaming,
    startNewConversation(): void {
      startNewConversationCalls.count += 1;
    },
    sendPhoto(photo: { uri: string }, kind: string): void {
      sendPhotoCalls.push({ uri: photo.uri, kind });
    },
  };
}
