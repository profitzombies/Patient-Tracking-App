/**
 * Session for the operations app — real Supabase auth in front, with the
 * demo persona chooser as an explicit bypass underneath.
 *
 * Precedence: a real signed-in session always wins. An active HQ membership
 * picks the HQ area regardless of the compatibility role on profiles.
 * Otherwise the profile role picks provider/patient behavior. While nobody is
 * signed in, the demo bypass ("Explore the demo" on the sign-in screen) still
 * sets a sessionStorage persona so investor walkthroughs need no credentials.
 * Sign out clears both worlds.
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
import type { HqRole } from '@/data/hq/team';

export type Persona = 'hq-admin' | 'office';
export type AuthRole = 'hq_admin' | 'provider_staff' | 'patient';
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';
export type RoleStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SignUpOutcome = 'session' | 'confirm-email' | 'verify-phone' | 'error';

const STORAGE_KEY = 'thinnr-ops-persona';
const STAFF_ROLE_POLL_MS = 10_000;

function isAuthRole(value: unknown): value is AuthRole {
  return value === 'hq_admin' || value === 'provider_staff' || value === 'patient';
}

function normalizeHqRole(value: unknown): HqRole | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/[_-]+/g, ' ') : '';
  if (normalized === 'super admin') return 'Super Admin';
  if (normalized === 'admin') return 'Admin';
  if (normalized === 'clinical') return 'Clinical';
  if (normalized === 'support') return 'Support';
  if (normalized === 'content') return 'Content';
  return null;
}

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

/**
 * A claimed real-world account (from the migrated THINNR rolls) deliberately
 * has no demo profile row — the API's whoami endpoint tells us who they are.
 */
export interface ClaimedWorkspaceInfo {
  kind: 'provider' | 'team_member';
  name: string | null;
  officeName: string | null;
  providerId: string | null;
}

interface SessionValue {
  /** Resolved area: the real role first; demo persona only while signed out. */
  persona: Persona | null;
  authStatus: AuthStatus;
  authUser: AuthUser | null;
  authRole: AuthRole | null;
  /** Department-level HQ authorization resolved from the active membership. */
  hqRole: HqRole | null;
  profileTitle: string | null;
  /** Provider office (seeded account id) for signed-in provider staff; null otherwise. */
  providerAccountCode: string | null;
  /** Set when the signed-in user is a claimed provider/office staffer with no demo profile. */
  claimedWorkspace: ClaimedWorkspaceInfo | null;
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
  const [hqRole, setHqRole] = useState<HqRole | null>(null);
  const [profileTitle, setProfileTitle] = useState<string | null>(null);
  const [providerAccountCode, setProviderAccountCode] = useState<string | null>(null);
  const [claimedWorkspace, setClaimedWorkspace] = useState<ClaimedWorkspaceInfo | null>(null);
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
    const client = supabase;
    if (!client || !userId) {
      setAuthRole(null);
      setProfileName(null);
      setHqRole(null);
      setProfileTitle(null);
      setProviderAccountCode(null);
      setClaimedWorkspace(null);
      setRoleStatus('idle');
      return;
    }
    let cancelled = false;
    // Never carry identity or privileges across a token/user transition while
    // the next live profile is being resolved.
    setAuthRole(null);
    setProfileName(null);
    setHqRole(null);
    setProfileTitle(null);
    setProviderAccountCode(null);
    setClaimedWorkspace(null);
    setRoleStatus('loading');

    // Claimed real-world accounts (patients, providers, office staff from the
    // migrated rolls) deliberately have no demo profile row. When the profile
    // lookup comes back empty, ask the API who this login belongs to.
    const resolveClaimedAccount = async () => {
      try {
        const { data: sessionData } = await client.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error('no session token');
        const response = await fetch('/api/claim/whoami', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (cancelled) return;
        if (response.ok && body) {
          if (body.kind === 'patient') {
            setAuthRole('patient');
            setProfileName(typeof body.name === 'string' ? body.name : null);
            setClaimedWorkspace(null);
            setRoleStatus('ready');
            return;
          }
          if (body.kind === 'provider' || body.kind === 'team_member') {
            setAuthRole(null);
            setProfileName(typeof body.name === 'string' ? body.name : null);
            setClaimedWorkspace({
              kind: body.kind,
              name: typeof body.name === 'string' ? body.name : null,
              officeName: typeof body.officeName === 'string' ? body.officeName : null,
              providerId: typeof body.providerId === 'string' ? body.providerId : null,
            });
            setRoleStatus('ready');
            return;
          }
        }
        setRoleStatus('error');
      } catch {
        if (!cancelled) setRoleStatus('error');
      }
    };

    void Promise.all([
      client
        .from('profiles')
        .select('role, display_name, provider_account_code')
        .eq('id', userId)
        .maybeSingle(),
      client
        .from('hq_memberships')
        .select('display_name, department_role, job_title')
        .eq('auth_user_id', userId)
        .eq('status', 'active')
        .maybeSingle(),
    ]).then(([profileResult, membershipResult]) => {
      if (cancelled) return;

      // Membership is authorization, so never fall back to a possibly stale
      // profiles.role when RLS/network failure leaves membership unresolved.
      if (membershipResult.error) {
        setRoleStatus('error');
        return;
      }
      if (membershipResult.data) {
        const departmentRole = normalizeHqRole(membershipResult.data.department_role);
        if (departmentRole === null) {
          setRoleStatus('error');
          return;
        }
        setAuthRole('hq_admin');
        setProfileName((membershipResult.data.display_name as string | null) ?? null);
        setHqRole(departmentRole);
        setProfileTitle((membershipResult.data.job_title as string | null) ?? null);
        setProviderAccountCode(null);
        setClaimedWorkspace(null);
        setRoleStatus('ready');
        return;
      }

      const { data, error } = profileResult;
      if (!error && !data) {
        void resolveClaimedAccount();
        return;
      }
      const role = data?.role as string | undefined;
      if (error || !data || !isAuthRole(role)) {
        setRoleStatus('error');
        return;
      }
      if (role === 'hq_admin') {
        // A profile-only HQ role is stale compatibility data, never access.
        setRoleStatus('error');
        writeStoredPersona(null);
        setDemoPersona(null);
        void client.auth.signOut();
        return;
      }
      setAuthRole(role);
      setProfileName((data.display_name as string | null) ?? null);
      setHqRole(null);
      setProfileTitle(null);
      setProviderAccountCode(
        role === 'provider_staff' ? ((data.provider_account_code as string | null) ?? null) : null,
      );
      setClaimedWorkspace(null);
      setRoleStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [userId, roleNonce]);

  // Profile roles and HQ memberships can change while the browser is open.
  // Realtime gives an immediate update where enabled; polling is the safe
  // fallback for projects that have not published both tables to Realtime.
  useEffect(() => {
    const client = supabase;
    if (!client || !userId) return;
    let disposed = false;

    const refreshActiveStaffRole = async () => {
      const [profileResult, membershipResult] = await Promise.all([
        client
          .from('profiles')
          .select('role, display_name, provider_account_code')
          .eq('id', userId)
          .maybeSingle(),
        client
          .from('hq_memberships')
          .select('display_name, department_role, job_title')
          .eq('auth_user_id', userId)
          .eq('status', 'active')
          .maybeSingle(),
      ]);
      if (disposed) return;

      if (membershipResult.error) {
        setRoleStatus('error');
        return;
      }

      if (membershipResult.data) {
        const nextHqRole = normalizeHqRole(membershipResult.data.department_role);
        if (nextHqRole === null) {
          setAuthRole(null);
          setHqRole(null);
          setProfileTitle(null);
          setProviderAccountCode(null);
          setRoleStatus('error');
          return;
        }
        setAuthRole('hq_admin');
        setProfileName((membershipResult.data.display_name as string | null) ?? null);
        setHqRole(nextHqRole);
        setProfileTitle((membershipResult.data.job_title as string | null) ?? null);
        setProviderAccountCode(null);
        setClaimedWorkspace(null);
        setRoleStatus('ready');
        return;
      }

      // An account which was admitted through a membership must not retain a
      // session after that membership is revoked, even if profiles.role still
      // says hq_admin due to compatibility data or trigger timing.
      if (authRole === 'hq_admin') {
        setAuthRole(null);
        setProfileName(null);
        setHqRole(null);
        setProfileTitle(null);
        setProviderAccountCode(null);
        setClaimedWorkspace(null);
        setRoleStatus('error');
        writeStoredPersona(null);
        setDemoPersona(null);
        await client.auth.signOut();
        return;
      }

      if (profileResult.error) {
        setRoleStatus('error');
        if (authRole === 'provider_staff') {
          setAuthRole(null);
          setProfileName(null);
          setProviderAccountCode(null);
          setClaimedWorkspace(null);
          writeStoredPersona(null);
          setDemoPersona(null);
          await client.auth.signOut();
        }
        return;
      }
      const data = profileResult.data;
      const nextRole = data?.role;
      // No profile is normal for claimed provider/patient identities. Their
      // whoami resolution remains authoritative outside HQ.
      if (!data) {
        if (authRole === 'provider_staff') {
          setAuthRole(null);
          setProfileName(null);
          setProviderAccountCode(null);
          setClaimedWorkspace(null);
          setRoleStatus('error');
          writeStoredPersona(null);
          setDemoPersona(null);
          await client.auth.signOut();
        }
        return;
      }
      if (!isAuthRole(nextRole)) {
        setAuthRole(null);
        setProfileName(null);
        setHqRole(null);
        setProfileTitle(null);
        setProviderAccountCode(null);
        setClaimedWorkspace(null);
        setRoleStatus('error');
        return;
      }
      if (nextRole === 'hq_admin') {
        setAuthRole(null);
        setProfileName(null);
        setHqRole(null);
        setProfileTitle(null);
        setProviderAccountCode(null);
        setClaimedWorkspace(null);
        setRoleStatus('error');
        writeStoredPersona(null);
        setDemoPersona(null);
        await client.auth.signOut();
        return;
      }
      if (authRole === 'provider_staff' && nextRole === 'patient') {
        setAuthRole('patient');
        setProfileName(null);
        setHqRole(null);
        setProfileTitle(null);
        setProviderAccountCode(null);
        setClaimedWorkspace(null);
        setRoleStatus('ready');
        writeStoredPersona(null);
        setDemoPersona(null);
        await client.auth.signOut();
        return;
      }
      setAuthRole(nextRole);
      setProfileName((data.display_name as string | null) ?? null);
      setHqRole(null);
      setProfileTitle(null);
      setProviderAccountCode(
        nextRole === 'provider_staff' ? ((data.provider_account_code as string | null) ?? null) : null,
      );
      setClaimedWorkspace(null);
      setRoleStatus('ready');
    };

    const channel = client
      .channel(`thinnr-active-role-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        () => void refreshActiveStaffRole(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'hq_memberships',
          filter: `auth_user_id=eq.${userId}`,
        },
        () => void refreshActiveStaffRole(),
      )
      .subscribe();
    const pollId = window.setInterval(() => void refreshActiveStaffRole(), STAFF_ROLE_POLL_MS);
    const refreshOnFocus = () => void refreshActiveStaffRole();
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);

    return () => {
      disposed = true;
      window.clearInterval(pollId);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      void client.removeChannel(channel);
    };
  }, [userId, authRole]);

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
      hqRole,
      profileTitle,
      providerAccountCode,
      claimedWorkspace,
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
      hqRole,
      profileTitle,
      providerAccountCode,
      claimedWorkspace,
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
