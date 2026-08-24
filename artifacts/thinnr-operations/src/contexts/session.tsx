/**
 * Session for the operations app — real Supabase auth in front, with the
 * demo persona chooser as an explicit bypass underneath.
 *
 * Precedence: a real signed-in session always wins. Its profile role picks
 * the area — hq_admin → HQ umbrella, provider_staff → office desk, patient →
 * a notice that the patient experience lives in the mobile app. While nobody
 * is signed in, the demo bypass ("Explore the demo" on the sign-in screen)
 * still sets a sessionStorage persona so investor walkthroughs need no
 * credentials. Sign out clears both worlds.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { describeAuthError, supabase, supabaseConfigured } from '@/lib/supabase';

export type Persona = 'hq-admin' | 'office';
export type AuthRole = 'hq_admin' | 'provider_staff' | 'patient';
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';
export type RoleStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SignUpOutcome = 'session' | 'confirm-email' | 'verify-phone' | 'error';

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

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string | null;
}

interface SessionValue {
  /** Resolved area: the real role first; demo persona only while signed out. */
  persona: Persona | null;
  authStatus: AuthStatus;
  authUser: AuthUser | null;
  authRole: AuthRole | null;
  roleStatus: RoleStatus;
  /** False when the Supabase env vars are missing (demo-only mode). */
  supabaseEnabled: boolean;
  /** Demo bypass — only meaningful while signed out. */
  signIn: (persona: Persona) => void;
  /** Ends both the real session and the demo persona. */
  signOut: () => void;
  signInWithPassword: (input: {
    email?: string;
    phone?: string;
    password: string;
  }) => Promise<{ error: string | null }>;
  signUpWithPassword: (input: {
    email?: string;
    phone?: string;
    password: string;
    displayName: string;
  }) => Promise<{ outcome: SignUpOutcome; error: string | null }>;
  verifyPhoneCode: (input: { phone: string; token: string }) => Promise<{ error: string | null }>;
  resendPhoneCode: (input: { phone: string }) => Promise<{ error: string | null }>;
  retryRoleFetch: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [demoPersona, setDemoPersona] = useState<Persona | null>(readStoredPersona);
  const [session, setSession] = useState<Session | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(
    supabaseConfigured ? 'loading' : 'signed-out',
  );
  const [authRole, setAuthRole] = useState<AuthRole | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [roleStatus, setRoleStatus] = useState<RoleStatus>('idle');
  const [roleNonce, setRoleNonce] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setAuthStatus(data.session ? 'signed-in' : 'signed-out');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      // State only in this callback — no awaited supabase calls (deadlocks).
      setSession(next);
      setAuthStatus(next ? 'signed-in' : 'signed-out');
    });
    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (!supabase || !userId) {
      setAuthRole(null);
      setProfileName(null);
      setRoleStatus('idle');
      return;
    }
    let cancelled = false;
    setRoleStatus('loading');
    void supabase
      .from('profiles')
      .select('role, display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        const role = data?.role as string | undefined;
        if (error || !data || (role !== 'hq_admin' && role !== 'provider_staff' && role !== 'patient')) {
          setAuthRole(null);
          setProfileName(null);
          setRoleStatus('error');
          return;
        }
        setAuthRole(role);
        setProfileName((data.display_name as string | null) ?? null);
        setRoleStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, roleNonce]);

  const signIn = useCallback((next: Persona) => {
    writeStoredPersona(next);
    setDemoPersona(next);
  }, []);

  const signOut = useCallback(() => {
    writeStoredPersona(null);
    setDemoPersona(null);
    if (supabase) void supabase.auth.signOut();
  }, []);

  const signInWithPassword = useCallback(
    async (input: { email?: string; phone?: string; password: string }) => {
      if (!supabase) return { error: 'Real sign-in isn\u2019t configured in this environment.' };
      const { error } = await supabase.auth.signInWithPassword(
        input.email !== undefined
          ? { email: input.email, password: input.password }
          : { phone: input.phone ?? '', password: input.password },
      );
      return { error: error ? describeAuthError(error.message) : null };
    },
    [],
  );

  const signUpWithPassword = useCallback(
    async (input: { email?: string; phone?: string; password: string; displayName: string }) => {
      if (!supabase) {
        return { outcome: 'error' as const, error: 'Real sign-in isn\u2019t configured in this environment.' };
      }
      if (input.email !== undefined) {
        // Confirmation links bounce back to this app (once the URL is
        // allow-listed in Supabase; otherwise the Site URL is used).
        const emailRedirectTo =
          typeof window !== 'undefined'
            ? window.location.origin + ((import.meta.env.BASE_URL as string | undefined) ?? '/')
            : undefined;
        const { data, error } = await supabase.auth.signUp({
          email: input.email,
          password: input.password,
          options: { data: { display_name: input.displayName }, emailRedirectTo },
        });
        if (error) return { outcome: 'error' as const, error: describeAuthError(error.message) };
        if (data.session) return { outcome: 'session' as const, error: null };
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          return { outcome: 'error' as const, error: 'That email already has an account \u2014 sign in instead.' };
        }
        return { outcome: 'confirm-email' as const, error: null };
      }
      const { data, error } = await supabase.auth.signUp({
        phone: input.phone ?? '',
        password: input.password,
        options: { data: { display_name: input.displayName } },
      });
      if (error) return { outcome: 'error' as const, error: describeAuthError(error.message) };
      if (data.session) return { outcome: 'session' as const, error: null };
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return { outcome: 'error' as const, error: 'That phone number already has an account \u2014 sign in instead.' };
      }
      return { outcome: 'verify-phone' as const, error: null };
    },
    [],
  );

  const verifyPhoneCode = useCallback(async (input: { phone: string; token: string }) => {
    if (!supabase) return { error: 'Real sign-in isn\u2019t configured in this environment.' };
    const { error } = await supabase.auth.verifyOtp({
      phone: input.phone,
      token: input.token,
      type: 'sms',
    });
    return { error: error ? describeAuthError(error.message) : null };
  }, []);

  const resendPhoneCode = useCallback(async (input: { phone: string }) => {
    if (!supabase) return { error: 'Real sign-in isn\u2019t configured in this environment.' };
    const { error } = await supabase.auth.resend({ phone: input.phone, type: 'sms' });
    return { error: error ? describeAuthError(error.message) : null };
  }, []);

  const retryRoleFetch = useCallback(() => {
    setRoleNonce((nonce) => nonce + 1);
  }, []);

  const authUser = useMemo<AuthUser | null>(() => {
    if (!session?.user) return null;
    const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
    const metaName = typeof meta.display_name === 'string' ? meta.display_name : null;
    return {
      id: session.user.id,
      email: session.user.email ?? null,
      phone: session.user.phone ?? null,
      displayName: profileName ?? metaName ?? session.user.email ?? session.user.phone ?? null,
    };
  }, [session, profileName]);

  const persona = useMemo<Persona | null>(() => {
    if (authStatus === 'signed-in') {
      if (authRole === 'hq_admin') return 'hq-admin';
      if (authRole === 'provider_staff') return 'office';
      return null; // patient / unresolved — the router shows the right screen
    }
    if (authStatus === 'loading') return null;
    return demoPersona;
  }, [authStatus, authRole, demoPersona]);

  const value = useMemo<SessionValue>(
    () => ({
      persona,
      authStatus,
      authUser,
      authRole,
      roleStatus,
      supabaseEnabled: supabaseConfigured,
      signIn,
      signOut,
      signInWithPassword,
      signUpWithPassword,
      verifyPhoneCode,
      resendPhoneCode,
      retryRoleFetch,
    }),
    [
      persona,
      authStatus,
      authUser,
      authRole,
      roleStatus,
      signIn,
      signOut,
      signInWithPassword,
      signUpWithPassword,
      verifyPhoneCode,
      resendPhoneCode,
      retryRoleFetch,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider');
  return context;
}
