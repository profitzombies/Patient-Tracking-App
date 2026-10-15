/**
 * The office operations app — shell, routes, and scroll behavior.
 *
 * Extracted from App.tsx so the same screens serve two callers:
 * - the standalone office persona (mounted at the router root), and
 * - the HQ admin drill-in (nest-mounted under /admin/accounts/:id/office
 *   inside a ProviderScopeProvider, which scopes every office screen to one
 *   provider account).
 *
 * Route paths are relative, so wouter resolves them against whichever base
 * the app is mounted under — no duplicated screens, no path rewrites.
 */
import { type ReactNode, useEffect, useRef } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import { Shell } from '@/components/layout/Shell';
import Overview from '@/pages/Overview';
import Patients from '@/pages/Patients';
import PatientDetail from '@/pages/PatientDetail';
import OfficeConversations from '@/pages/OfficeConversations';
import Analytics from '@/pages/Analytics';
import Leaderboard from '@/pages/Leaderboard';
import Subscriptions from '@/pages/Subscriptions';
import OfficePaymentsArea from '@/pages/office/payments/OfficePaymentsArea';
import OfficeTraining from '@/pages/OfficeTraining';
import OfficeTrainingCourse from '@/pages/OfficeTrainingCourse';
import OfficeTrainingLesson from '@/pages/OfficeTrainingLesson';
import OfficeTeammate from '@/pages/OfficeTeammate';
import OfficeAiSupport from '@/pages/OfficeAiSupport';
import OfficeSettings from '@/pages/OfficeSettings';
import OfficeTeam from '@/pages/OfficeTeam';
import OfficeAudit from '@/pages/OfficeAudit';
import OfficeFiles from '@/pages/OfficeFiles';
import Security from '@/pages/Security';
import OfficeAlerts from '@/pages/OfficeAlerts';
import OfficeAccess from '@/pages/OfficeAccess';
import { RestrictedRoutes } from '@/components/office/RestrictedAccess';
import { PracticeLaunchGuard } from '@/pages/PracticeLaunch';
import { useOfficeAccess } from '@/hooks/use-office-access';
import { OfficeRestrictionProvider, useOfficeRestriction } from '@/contexts/office-restriction';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';
import { officeKindOf } from '@/data/hq/accounts';
import { officeKindHasResellerContent } from '@/lib/office-kind';

export function OfficeApp() {
  return (
    <RoutedErrorBoundary>
      <OfficeRestrictionGate>
      <PracticeLaunchGuard>
        <Switch>
          <Route>
            <Shell>
              <PatientRouteScrollBehavior />
              <RestrictedRoutes>
                <OfficeRoutes />
              </RestrictedRoutes>
            </Shell>
          </Route>
        </Switch>
      </PracticeLaunchGuard>
      </OfficeRestrictionGate>
    </RoutedErrorBoundary>
  );
}

/**
 * Publishes the office's narrowed-for-nonpayment state to the workspace.
 *
 * The server is the authority — it refuses the blocked surface on its own —
 * so this never holds the app while the answer is in flight: an office that
 * is not restricted must not see a spinner on every visit.
 */
function OfficeRestrictionGate({ children }: { children: ReactNode }) {
  const access = useOfficeAccess();
  const scope = useProviderScope();
  const { claimedWorkspace } = useSession();
  const restricted = access.data?.restricted === true;
  // The kind arrives with whatever the client already reads at sign-in: the
  // HQ account for a drill-in, the office access payload for the office's own
  // staff, and whoami for a claimed login — no extra poll.
  const officeKind = scope
    ? officeKindOf(scope.officeKind)
    : access.data?.office_kind !== undefined
      ? officeKindOf(access.data.office_kind)
      : claimedWorkspace?.officeKind ?? null;
  return (
    <OfficeRestrictionProvider
      value={{ restricted, message: restricted ? access.data?.message ?? null : null, officeKind }}
    >
      {children}
    </OfficeRestrictionProvider>
  );
}

/** The office screens. wouter's Switch flattens fragments and skips `false`. */
function OfficeRoutes() {
  const { officeKind } = useOfficeRestriction();
  return (
    <Switch>
      <Route path="/" component={Overview} />
      <Route path="/patients" component={Patients} />
      <Route path="/patients/:id" component={PatientDetail} />
      <Route path="/alerts" component={OfficeAlerts} />
      <Route path="/conversations" component={OfficeConversations} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/leaderboard" component={Leaderboard} />
      <Route path="/subscriptions" component={Subscriptions} />
      {/* Payments (Stripe Connect) owns its sub-routes. */}
      <Route path="/payments" nest component={OfficePaymentsArea} />
      {/* Reseller-only material. A software-only office has no such
          pages: the fragment is left out, so these URLs fall through
          to the in-app not-found page below (the server refuses the
          data regardless). */}
      {officeKindHasResellerContent(officeKind) && <>
        <Route path="/training" component={OfficeTraining} />
        <Route path="/files" component={OfficeFiles} />
        {/* Literal /training/team must outrank the :courseId catch-all. */}
        <Route path="/training/team/:viewerId" component={OfficeTeammate} />
        <Route path="/training/:courseId/videos/:videoId" component={OfficeTrainingLesson} />
        <Route path="/training/:courseId" component={OfficeTrainingCourse} />
      </>}
      <Route path="/ai-support" component={OfficeAiSupport} />
      <Route path="/settings" component={OfficeSettings} />
      <Route path="/team" component={OfficeTeam} />
      <Route path="/audit" component={OfficeAudit} />
      <Route path="/security" component={Security} />
      <Route path="/account" component={OfficeAccess} />
      <Route component={NotFound} />
    </Switch>
  );
}

function PatientRouteScrollBehavior() {
  const [location] = useLocation();
  const navigationEntry = typeof performance !== 'undefined'
    ? performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    : undefined;
  const isHistoryNavigation = useRef(
    navigationEntry?.type === 'back_forward',
  );

  useEffect(() => {
    const markHistoryNavigation = () => {
      isHistoryNavigation.current = true;
    };
    window.addEventListener('popstate', markHistoryNavigation);
    return () => window.removeEventListener('popstate', markHistoryNavigation);
  }, []);

  useEffect(() => {
    const isPatientRecord = /^\/patients\/[^/]+$/.test(location);
    if (isPatientRecord && !isHistoryNavigation.current) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
    isHistoryNavigation.current = false;
  }, [location]);

  return null;
}

export function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
