import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/contexts/session";
import { useProviderScope } from "@/contexts/provider-scope";
import { fetchOfficeRoster } from "@/lib/office-roster";
import { officeRosterQueryKey } from "@/components/office/LiveRoster";

export function useLiveRoster(includeArchived = false) {
  const { authUser, authStatus, authRole } = useSession();
  const scope = useProviderScope();

  const liveEnabled =
    authStatus === 'signed-in' &&
    (authRole === 'provider_staff' || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
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