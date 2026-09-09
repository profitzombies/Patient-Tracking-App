import { createContext, useContext } from 'react';

export const CareTeamUnreadContext = createContext(0);

export function useCareTeamUnreadCount(): number {
  return useContext(CareTeamUnreadContext);
}