import { useQuery } from '@tanstack/react-query';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import {
  fetchOfficeAlertDigests,
  fetchOfficeAlerts,
  fetchOfficeAlertSettings,
  officeAlertDigestsQueryKey,
  officeAlertsQueryKey,
  officeAlertSettingsQueryKey,
} from '@/lib/office-alerts-api';

export function useOfficeAlerts() {
  const scope = useLiveOfficeScope();
  const query = useQuery({
    queryKey: [...officeAlertsQueryKey(scope.liveOffice), scope.authUserId],
    queryFn: () => fetchOfficeAlerts(scope.liveOffice),
    enabled: scope.liveEnabled,
    refetchInterval: scope.liveEnabled ? 30_000 : false,
  });
  return { ...query, ...scope };
}

export function useOfficeAlertDigests(date?: string | null) {
  const scope = useLiveOfficeScope();
  const query = useQuery({
    queryKey: [...officeAlertDigestsQueryKey(scope.liveOffice), date ?? 'latest', scope.authUserId],
    queryFn: () => fetchOfficeAlertDigests(date, scope.liveOffice),
    enabled: scope.liveEnabled,
  });
  return { ...query, ...scope };
}

export function useOfficeAlertSettings() {
  const scope = useLiveOfficeScope();
  const query = useQuery({
    queryKey: [...officeAlertSettingsQueryKey(scope.liveOffice), scope.authUserId],
    queryFn: () => fetchOfficeAlertSettings(scope.liveOffice),
    enabled: scope.liveEnabled,
  });
  return { ...query, ...scope };
}