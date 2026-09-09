import type { ChatThread } from '@/context/PatientAccountContext';

type ThreadType = ChatThread | 'care_team';

type ChatSyncListener = (thread: ThreadType) => void;

const listeners = new Set<ChatSyncListener>();

/** Announces that a server-side care-team reply may be available. */
export function emitChatSync(thread: ThreadType): void {
  for (const listener of listeners) listener(thread);
}

/** Subscribes to care-team reply notifications. */
export function subscribeChatSync(listener: ChatSyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}