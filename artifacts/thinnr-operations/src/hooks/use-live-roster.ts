import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/contexts/session";
import { useProviderScope } from "@/contexts/provider-scope";
import { fetchOfficeRoster } from "@/lib/office-roster";
import { officeRosterQueryKey } from "@/components/office/LiveRoster";

export function useLiveRoster(includeArchived = false) {
  const { authUser, authStatus, authRole, claimedWorkspace } = useSession();
  const scope = useProviderScope();

  // Claimed office logins carry no profile role, only the claimed workspace;
  // they are real staff and must read the live roster, never the demo one.
  const isClaimedOffice = claimedWorkspace?.kind === 'provider' || claimedWorkspace?.kind === 'team_member';
  const liveEnabled =
    authStatus === 'signed-in' &&
    (authRole === 'provider_staff' || isClaimedOffice || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
  const liveOffice = authRole === 'hq_admin' ? (scope?.providerId ?? null) : null;

  const query = useQuery({
    queryKey: [...officeRosterQueryKey(liveOffice), includeArchived ? 'archived' : 'current', authUser?.id],
    queryFn: () => fetchOfficeRoster(liveOffice, includeArchived),
    enabled: liveEnabled,
    refetchInterval: liveEnabled ? 30_000 : false,
  });

  return {
    ...query,
    liveEnabled,
    liveOffice,
  };
}