/**
 * Node stand-in for @/context/CoachChatContext: the meal-photo flow only
 * uses sendPhoto + isStreaming. Calls are recorded so the suite can prove
 * "Use this photo" hands the prepared photo to the coach as a meal turn.
 */
export interface SendPhotoCall {
  photo: { uri: string; width: number; height: number };
  kind: string;
  options?: { mealSlot?: string };
}

export const sendPhotoCalls: SendPhotoCall[] = [];
export let startNewConversationCalls = 0;

export function clearSendPhotoCalls(): void {
  sendPhotoCalls.length = 0;
  startNewConversationCalls = 0;
}

export const coachState = { isStreaming: false };

export function useCoachChat() {
  return {
    isStreaming: coachState.isStreaming,
    startNewConversation(): void {
      startNewConversationCalls += 1;
    },
    sendPhoto(
      photo: { uri: string; width: number; height: number },
      kind: string,
      options?: { mealSlot?: string },
    ): void {
      sendPhotoCalls.push({ photo, kind, options });
    },
  };
}
