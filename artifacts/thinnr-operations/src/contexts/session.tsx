/**
 * Session for the operations app — real Supabase auth in front, with the
 * demo persona chooser as an explicit bypass underneath.
 *
 * Precedence: a real signed-in session always wins. An active HQ membership
 * picks the HQ area regardless of the compatibility role on profiles.
 * Otherwise the profile role picks provider/patient behavior. While nobody is
 * signed in, the demo bypass ("Explore the demo" on the sign-in screen) still
 * sets a sessionStorage persona so investor walkthroughs need no credentials —
 * but only where the demo switch allows it (src/lib/demo-entry.ts); the
 * published app has no persona at all. Sign out clears both worlds.
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
import { demoEntryEnabled } from '@/lib/demo-entry';
import type { HqRole } from '@/data/hq/team';
import { useIdleTimeout, type IdleState } from '@/hooks/useIdleTimeout';

export type Persona = 'hq-admin' | 'office';
export type AuthRole = 'hq_admin' | 'provider_staff' | 'patient';
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';
export type RoleStatus = 'idle' | 'loading' | 'ready' | 'error';

const STORAGE_KEY = 'thinnr-ops-persona';
const STAFF_ROLE_POLL_MS = 10_000;

/**
 * Web device memory for code login: after a successful code the browser stays
 * signed in for ~30 days; past that, the next visit asks for a fresh code.
 * The stamp lives in localStorage next to Supabase's own persisted session.
 */
const DEVICE_MEMORY_KEY = 'thinnr-ops-code-login-at';
const DEVICE_ID_KEY = 'thinnr.device-id';
const DEVICE_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

function deviceMemoryExpired(): boolean {
  try {
    const raw = window.localStorage.getItem(DEVICE_MEMORY_KEY);
    const at = raw ? Number(raw) : Number.NaN;
    return !Number.isFinite(at) || Date.now() - at > DEVICE_MEMORY_MS;
  } catch {
    // Storage being unavailable must not lock anyone into a sign-in loop.
    return false;
  }
}

function stampDeviceMemory() {
  try {
    window.localStorage.setItem(DEVICE_MEMORY_KEY, String(Date.now()));
  } catch {
    // Best-effort; the session itself still works for this visit.
  }
}

function clearDeviceMemory() {
  try {
    window.localStorage.removeItem(DEVICE_MEMORY_KEY);
  } catch {
    // Best-effort.
  }
}

function getOrCreateDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[A-Za-z0-9_.:-]{8,80}$/.test(existing)) return existing;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `web-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return `web-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

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

interface HqSessionResult {
  data: { displayName: string | null; departmentRole: HqRole; jobTitle: string | null } | null;
  error: boolean;
}

async function fetchHqSession(client: NonNullable<typeof supabase>): Promise<HqSessionResult> {
  try {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return { data: null, error: false };
    const response = await fetch('/api/hq-session', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) return { data: null, error: false };
    if (!response.ok) return { data: null, error: true };
    const body = (await response.json()) as Record<string, unknown>;
    const departmentRole = normalizeHqRole(body.departmentRole);
    if (!departmentRole) return { data: null, error: true };
    return {
      data: {
        departmentRole,
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        jobTitle: typeof body.jobTitle === 'string' ? body.jobTitle : null,
      },
      error: false,
    };
  } catch {
    return { data: null, error: true };
  }
}

/** sessionStorage can throw (privacy modes); the demo degrades to in-memory. */
function readStoredPersona(): Persona | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    // Demo entry switched off (the published app): a persona remembered from
    // an earlier visit is cleared, never restored.
    if (!demoEntryEnabled) {
      if (raw !== null) window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
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

export interface StaffSessionInfo {
  staffKind: 'hq' | 'provider' | 'team_member';
  providerId: string | null;
  idleTimeoutMinutes: number;
  idleTimeoutSource: 'hq' | 'office';
  freshCode: {
    codeVerifiedAt: string | null;
    fresh: boolean;
    windowMinutes: number;
  };
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
  idleTimeoutMinutes: number;
  staffSession: StaffSessionInfo | null;
  idleState: IdleState;
  secondsLeft: number;
  dismissIdleWarning: () => void;
  /** False when the Supabase env vars are missing (demo-only mode). */
  supabaseEnabled: boolean;
  /** Demo bypass — only meaningful while signed out. */
  signIn: (persona: Persona) => void;
  /** Ends both the real session and the demo persona. */
  signOut: () => void;
  /** Asks the server to email a one-time sign-in code to a staff address. */
  requestStaffCode: (email: string) => Promise<{
    requestId: string | null;
    message: string | null;
    devCode: string | null;
    error: string | null;
  }>;
  /** Trades a correct code for a real Supabase session on this device. */
  verifyStaffCode: (input: { requestId: string; code: string }) => Promise<{
    error: string | null;
    secondFactor?: { stepToken: string; mode: 'sms' | 'enroll'; destination: string | null };
  }>;
  startStaffPhoneStep: (input: { stepToken: string; phone?: string }) => Promise<{
    error: string | null;
    code?: string;
    requestId?: string;
    destination?: string;
    devCode?: string | null;
  }>;
  verifyStaffPhoneCode: (input: { stepToken: string; requestId: string; code: string }) => Promise<{
    error: string | null;
    code?: string;
  }>;
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
  const [staffSession, setStaffSession] = useState<StaffSessionInfo | null>(null);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(15);

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let cancelled = false;
    void client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session && deviceMemoryExpired()) {
        // The ~30-day device memory has lapsed (or predates code login) —
        // ask for a fresh code instead of silently resuming.
        clearDeviceMemory();
        void client.auth.signOut();
        setSession(null);
        setAuthStatus('signed-out');
        return;
      }
      setSession(data.session);
      setAuthStatus(data.session ? 'signed-in' : 'signed-out');
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
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
      fetchHqSession(client),
    ]).then(([profileResult, hqSessionResult]) => {
      if (cancelled) return;

      // The same server-side membership resolver that guards every HQ API
      // route is authoritative here too. This avoids browser-RLS failures
      // disagreeing with a valid active HQ session.
      if (hqSessionResult.error) {
        setRoleStatus('error');
        return;
      }
      if (hqSessionResult.data) {
        const { departmentRole, displayName, jobTitle } = hqSessionResult.data;
        setAuthRole('hq_admin');
        setProfileName(displayName);
        setHqRole(departmentRole);
        setProfileTitle(jobTitle);
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
      const [profileResult, hqSessionResult] = await Promise.all([
        client
          .from('profiles')
          .select('role, display_name, provider_account_code')
          .eq('id', userId)
          .maybeSingle(),
        fetchHqSession(client),
      ]);
      if (disposed) return;

      if (hqSessionResult.error) {
        setRoleStatus('error');
        return;
      }

      if (hqSessionResult.data) {
        const { departmentRole: nextHqRole, displayName, jobTitle } = hqSessionResult.data;
        setAuthRole('hq_admin');
        setProfileName(displayName);
        setHqRole(nextHqRole);
        setProfileTitle(jobTitle);
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
    // Demo entry switched off: nothing may pick a persona.
    if (!demoEntryEnabled) return;
    writeStoredPersona(next);
    setDemoPersona(next);
  }, []);

  const signOut = useCallback(() => {
    writeStoredPersona(null);
    setDemoPersona(null);
    clearDeviceMemory();
    if (supabase) void supabase.auth.signOut();
  }, []);

  const isRealStaff = authStatus === 'signed-in' && roleStatus === 'ready' && (
    authRole === 'hq_admin' ||
    authRole === 'provider_staff' ||
    claimedWorkspace?.kind === 'provider' ||
    claimedWorkspace?.kind === 'team_member'
  );

  useEffect(() => {
    if (!isRealStaff || !session?.access_token) {
      setStaffSession(null);
      setIdleTimeoutMinutes(15);
      return;
    }

    let cancelled = false;
    let lastFetchedAt = 0;
    const fetchStaffSession = async () => {
      const now = Date.now();
      if (lastFetchedAt && now - lastFetchedAt < 60_000) return;
      lastFetchedAt = now;
      try {
        const response = await fetch('/api/staff-session', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!response.ok) throw new Error('staff session unavailable');
        const body = (await response.json()) as StaffSessionInfo;
        if (!Number.isFinite(body.idleTimeoutMinutes)) throw new Error('invalid idle timeout');
        if (!cancelled) {
          setStaffSession(body);
          setIdleTimeoutMinutes(body.idleTimeoutMinutes);
        }
      } catch {
        if (!cancelled) {
          setStaffSession(null);
          setIdleTimeoutMinutes(15);
        }
      }
    };
    void fetchStaffSession();
    const refreshOnFocus = () => void fetchStaffSession();
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [isRealStaff, session?.access_token]);

  const { idleState, secondsLeft, dismissIdleWarning } = useIdleTimeout({
    enabled: isRealStaff,
    idleTimeoutMinutes,
    signOut,
  });

  const requestStaffCode = useCallback(async (email: string) => {
    const failure = (message: string) => ({
      requestId: null,
      message: null,
      devCode: null,
      error: message,
    });
    if (!supabaseConfigured) {
      return failure('Real sign-in isn\u2019t configured in this environment.');
    }
    try {
      const response = await fetch('/api/auth/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realm: 'staff', identifier: email }),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !body || typeof body.requestId !== 'string') {
        return failure(
          typeof body?.error === 'string' ? body.error : 'Could not send a code right now. Try again in a moment.',
        );
      }
      return {
        requestId: body.requestId,
        message: typeof body.message === 'string' ? body.message : null,
        devCode: typeof body.devCode === 'string' ? body.devCode : null,
        error: null,
      };
    } catch {
      return failure('Could not reach the sign-in service. Check your connection and try again.');
    }
  }, []);

  const verifyStaffCode = useCallback(async (input: { requestId: string; code: string }) => {
    if (!supabase) return { error: 'Real sign-in isn\u2019t configured in this environment.' };
    try {
      const response = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-thinnr-device': getOrCreateDeviceId(),
          'x-thinnr-platform': 'web',
        },
        body: JSON.stringify({ requestId: input.requestId, code: input.code }),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        response.ok
        && body?.secondFactor
        && typeof body.secondFactor === 'object'
      ) {
        const secondFactor = body.secondFactor as Record<string, unknown>;
        if (
          typeof secondFactor.stepToken === 'string'
          && (secondFactor.mode === 'sms' || secondFactor.mode === 'enroll')
        ) {
          return {
            error: null,
            secondFactor: {
              stepToken: secondFactor.stepToken,
              mode: secondFactor.mode as 'sms' | 'enroll',
              destination: typeof secondFactor.destination === 'string'
                ? secondFactor.destination
                : null,
            },
          };
        }
      }
      if (!response.ok || !body || typeof body.tokenHash !== 'string') {
        return {
          error:
            typeof body?.error === 'string'
              ? body.error
              : 'That code didn\u2019t work. Request a fresh one and try again.',
        };
      }
      const { error } = await supabase.auth.verifyOtp({
        token_hash: body.tokenHash,
        type: 'email',
      });
      if (error) return { error: describeAuthError(error.message) };
      if (typeof body.signInId === 'string') {
        void supabase.auth.getSession().then(({ data }) => {
          const accessToken = data.session?.access_token;
          if (!accessToken) return;
          return fetch('/api/security/me/attach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ signInId: body.signInId }),
          }).catch(() => undefined);
        });
      }
      stampDeviceMemory();
      return { error: null };
    } catch {
      return { error: 'Could not reach the sign-in service. Check your connection and try again.' };
    }
  }, []);

  const startStaffPhoneStep = useCallback(async (input: { stepToken: string; phone?: string }) => {
    try {
      const response = await fetch('/api/auth/login/phone/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !body || typeof body.requestId !== 'string') {
        return {
          error: typeof body?.error === 'string' ? body.error : 'Could not send a text right now. Try again.',
          code: typeof body?.code === 'string' ? body.code : undefined,
        };
      }
      return {
        error: null,
        requestId: body.requestId,
        destination: typeof body.destination === 'string' ? body.destination : '',
        devCode: typeof body.devCode === 'string' ? body.devCode : null,
      };
    } catch {
      return { error: 'Could not reach the sign-in service. Check your connection and try again.' };
    }
  }, []);

  const verifyStaffPhoneCode = useCallback(async (input: {
    stepToken: string;
    requestId: string;
    code: string;
  }) => {
    if (!supabase) return { error: 'Real sign-in isn’t configured in this environment.' };
    try {
      const response = await fetch('/api/auth/login/phone/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-thinnr-device': getOrCreateDeviceId(),
          'x-thinnr-platform': 'web',
        },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !body || typeof body.tokenHash !== 'string') {
        return {
          error: typeof body?.error === 'string' ? body.error : 'That code didn’t work. Try again.',
          code: response.status === 409
            ? 'STEP_EXPIRED'
            : typeof body?.code === 'string' ? body.code : undefined,
        };
      }
      const { error } = await supabase.auth.verifyOtp({ token_hash: body.tokenHash, type: 'email' });
      if (error) return { error: describeAuthError(error.message) };
      if (typeof body.signInId === 'string') {
        void supabase.auth.getSession().then(({ data }) => {
          const accessToken = data.session?.access_token;
          if (!accessToken) return;
          return fetch('/api/security/me/attach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ signInId: body.signInId }),
          }).catch(() => undefined);
        });
      }
      stampDeviceMemory();
      return { error: null };
    } catch {
      return { error: 'Could not reach the sign-in service. Check your connection and try again.' };
    }
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
      if (authRole === 'provider_staff' || claimedWorkspace) return 'office';
      return null; // patient / unresolved — the router shows the right screen
    }
    if (authStatus === 'loading') return null;
    return demoEntryEnabled ? demoPersona : null;
  }, [authStatus, authRole, claimedWorkspace, demoPersona]);

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
      idleTimeoutMinutes,
      staffSession,
      idleState,
      secondsLeft,
      dismissIdleWarning,
      supabaseEnabled: supabaseConfigured,
      signIn,
      signOut,
      requestStaffCode,
      verifyStaffCode,
      startStaffPhoneStep,
      verifyStaffPhoneCode,
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
      idleTimeoutMinutes,
      staffSession,
      idleState,
      secondsLeft,
      dismissIdleWarning,
      signIn,
      signOut,
      requestStaffCode,
      verifyStaffCode,
      startStaffPhoneStep,
      verifyStaffPhoneCode,
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
