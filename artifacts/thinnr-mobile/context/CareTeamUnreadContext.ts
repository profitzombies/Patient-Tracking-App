import { createContext, useContext } from 'react';

export const CareTeamUnreadContext = createContext(0);

export function useCareTeamUnreadCount(): number {
  return useContext(CareTeamUnreadContext);
}

/**
 * Whether the patient may write into their care-team thread right now.
 *
 * False keeps the thread reachable (history is still theirs to read) while
 * every entry point stops inviting a new message. Defaults to true so nothing
 * flickers into a read-only label before the conversation has loaded.
 */
export const CareTeamComposeContext = createContext(true);

export function useCareTeamCanCompose(): boolean {
  return useContext(CareTeamComposeContext);
}
