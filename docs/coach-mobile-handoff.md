# Coach mobile conversation handoff

`useCoachChat()` exposes the following history-facing API for patient screens.
The provider owns selection and transcript hydration; history screens should
never mutate the selected transcript directly.

```ts
selectedConversation: CoachConversation | null;
conversationScopeKey: string | null;
conversationError: string | null;
isConversationLoading: boolean;

startNewConversation(): void;
selectConversation(id: string): Promise<void>;
listConversations(
  archived: boolean,
  offset?: number,
): Promise<CoachConversationPage>;
setArchived(
  conversation: CoachConversation,
  archived: boolean,
): Promise<void>;
loadOlder(): Promise<void>;
hasOlderMessages: boolean;
isLoadingOlder: boolean;
```

`startNewConversation()` is intentionally synchronous: it only clears the
local composer/transcript context. The server row is created by the first
substantive send. `selectConversation()` resolves after the selected
conversation's newest page has hydrated. `loadOlder()` prepends the next
chronological page for the currently selected conversation.

`conversationScopeKey` changes for every patient/conversation selection and
is suitable for resetting screen-local drafts, staged camera work, and
scroll anchors. When `selectedConversation.archivedAt` is non-null, screens
must present the transcript as read-only and use `setArchived(conversation,
false)` before allowing any composer or card mutation.