/**
 * Which live office the current session may call the office self-service
 * endpoints for. Signed-in office staff are scoped server-side (no id
 * sent); an HQ drill-in names the account it is viewing; the guided demo
 * persona never calls the live endpoints at all.
 */
import { useSession } from '@/contexts/session';
import { useProviderScope } from '@/contexts/provider-scope';

export interface LiveOfficeScope {
  /** True when a live endpoint may be called for this session. */
  liveEnabled: boolean;
  /** Explicit office id for HQ drill-ins; null for office staff (server-derived). */
  liveOffice: string | null;
  /** True while the demo persona is active (no real sign-in). */
  isDemo: boolean;
  /** True while the auth session is still being resolved. */
  isResolving: boolean;
  authUserId: string | null;
}

export function useLiveOfficeScope(): LiveOfficeScope {
  const { authUser, authStatus, authRole } = useSession();
  const scope = useProviderScope();
  const liveEnabled =
    authStatus === 'signed-in' &&
    (authRole === 'provider_staff' || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
  return {
    liveEnabled,
    liveOffice: authRole === 'hq_admin' ? (scope?.providerId ?? null) : null,
    isDemo: authStatus === 'signed-out',
    isResolving: authStatus === 'loading',
    authUserId: authUser?.id ?? null,
  };
}
