/**
 * Scope-aware data hooks for the office screens.
 *
 * The office pages read their demo data through these hooks instead of the
 * MOCK_* singletons so the same screens serve two callers:
 *
 * - The standalone office demo (no provider scope): every hook returns the
 *   exact program-wide singleton — same object references, same values — so
 *   behavior is bit-identical to the pre-HQ app.
 * - An HQ admin drill-in (ProviderScopeProvider present): patients,
 *   providers, and subscriptions filter down to the scoped account, and the
 *   analytics swap to that account's exact seeded split.
 *
 * The product catalog is intentionally global — it is THINNR's program
 * catalog, identical for every office.
 */
import { useMemo } from 'react';
import {
  MOCK_ANALYTICS,
  MOCK_PATIENTS,
  MOCK_PROVIDERS,
  MOCK_SUBSCRIPTIONS,
  getDailyRevenue,
  type Patient,
  type Provider,
  type Subscription,
} from '@/data/mock-data';
import {
  ACCOUNT_CHANGE_BADGES,
  getAccountAnalytics,
  getAccountDailyRevenue,
} from '@/data/hq/accounts';
import {
  PROGRAM_ANALYTICS_RANGE,
  buildAccountAnalyticsRange,
  type ScopedAnalyticsRange,
} from '@/data/hq/scoped-analytics';
import { demoOfficeAppUsageInsights } from '@/data/hq/app-usage-insights-demo';
import { useProviderScope } from '@/contexts/provider-scope';
import type { OperationsDateRange } from '@/lib/date-range-keys';
import type { AppUsageInsights } from '@workspace/api-client-react';
import type { InsightsDataset } from '@workspace/app-usage-insights';

export function useScopedPatients(): Patient[] {
  const scope = useProviderScope();
  return useMemo(
    () => (scope ? MOCK_PATIENTS.filter((patient) => patient.providerId === scope.providerId) : MOCK_PATIENTS),
    [scope],
  );
}

export function useScopedProviders(): Provider[] {
  const scope = useProviderScope();
  return useMemo(
    () => (scope ? MOCK_PROVIDERS.filter((provider) => provider.id === scope.providerId) : MOCK_PROVIDERS),
    [scope],
  );
}

export function useScopedSubscriptions(): Subscription[] {
  const scope = useProviderScope();
  return useMemo(() => {
    if (!scope) return MOCK_SUBSCRIPTIONS;
    const patientIds = new Set(
      MOCK_PATIENTS.filter((patient) => patient.providerId === scope.providerId).map((patient) => patient.id),
    );
    return MOCK_SUBSCRIPTIONS.filter((subscription) => patientIds.has(subscription.patientId));
  }, [scope]);
}

export function useScopedAnalytics(): typeof MOCK_ANALYTICS {
  const scope = useProviderScope();
  return useMemo(() => (scope ? getAccountAnalytics(scope) : MOCK_ANALYTICS), [scope]);
}

/** Per-day demo revenue for the current scope (Overview trend chart). */
export function useScopedDailyRevenue(): (dateKey: string) => number {
  const scope = useProviderScope();
  return useMemo(() => {
    if (!scope) return getDailyRevenue;
    const accountId = scope.id;
    return (dateKey: string) => getAccountDailyRevenue(dateKey, accountId);
  }, [scope]);
}

/** Range selectors for the Revenue & Outcomes page in the current scope. */
export function useScopedAnalyticsRange(): ScopedAnalyticsRange {
  const scope = useProviderScope();
  return useMemo(() => (scope ? buildAccountAnalyticsRange(scope) : PROGRAM_ANALYTICS_RANGE), [scope]);
}

/** Metric change badges: program literals unscoped, account variants scoped. */
export function useScopedChangeBadges(): { mrr: string; patients: string; avgLost: string } {
  const scope = useProviderScope();
  return useMemo(
    () =>
      (scope && ACCOUNT_CHANGE_BADGES[scope.id]) || { mrr: '+12.4%', patients: '+8.7%', avgLost: '+3.2%' },
    [scope],
  );
}

/**
 * Demo "When patients use the app" insights for the current scope: the
 * program-wide seed in the standalone office demo, the drilled-in account's
 * own slice under HQ (the same slice HQ's Insights filter shows for it).
 */
export function useScopedAppUsageInsights(dataset: InsightsDataset, range: OperationsDateRange): AppUsageInsights {
  const scope = useProviderScope();
  return useMemo(
    () =>
      demoOfficeAppUsageInsights(
        dataset,
        range,
        scope ? { id: scope.id, officeName: scope.officeName, activePatientCount: scope.activePatientCount } : null,
      ),
    [dataset, range, scope],
  );
}
