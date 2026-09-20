import { useQuery } from '@tanstack/react-query';
import { useHqBillingScope } from '@/hooks/use-billing';
import { publicBilling } from '@/lib/billing-api';

export function useBillingSandbox() {
  const scope = useHqBillingScope();
  return useQuery({
    queryKey: [...scope.base, 'sandbox'],
    queryFn: () => publicBilling.config(),
    enabled: scope.liveEnabled,
    staleTime: 0,
    refetchInterval: 30_000,
  });
}
