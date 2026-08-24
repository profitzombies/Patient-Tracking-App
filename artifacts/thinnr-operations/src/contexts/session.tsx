/**
 * Simulated sign-in for the operations demo.
 *
 * The app opens on a persona chooser (THINNR HQ admin vs office staff) —
 * there are no real accounts, passwords, or servers. The chosen persona is
 * kept in sessionStorage so a reload stays signed in for the tab, while a
 * fresh tab starts back at the chooser. Route gating lives in App.tsx: the
 * office persona can never reach /admin and the admin persona always lands
 * inside it.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Persona = 'hq-admin' | 'office';

const STORAGE_KEY = 'thinnr-ops-persona';

/** sessionStorage can throw (privacy modes); the demo degrades to in-memory. */
function readStoredPersona(): Persona | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw === 'hq-admin' || raw === 'office' ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredPersona(persona: Persona | null) {
  try {
    if (persona === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, persona);
  } catch {
    // In-memory state still drives the session; persistence is best-effort.
  }
}

interface SessionValue {
  persona: Persona | null;
  signIn: (persona: Persona) => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [persona, setPersona] = useState<Persona | null>(readStoredPersona);

  const signIn = useCallback((next: Persona) => {
    writeStoredPersona(next);
    setPersona(next);
  }, []);

  const signOut = useCallback(() => {
    writeStoredPersona(null);
    setPersona(null);
  }, []);

  const value = useMemo(() => ({ persona, signIn, signOut }), [persona, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider');
  return context;
}
