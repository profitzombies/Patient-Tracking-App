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
import Analytics from '@/pages/Analytics';
import Leaderboard from '@/pages/Leaderboard';
import Subscriptions from '@/pages/Subscriptions';
import OfficeTraining from '@/pages/OfficeTraining';
import OfficeTrainingCourse from '@/pages/OfficeTrainingCourse';
import OfficeTrainingLesson from '@/pages/OfficeTrainingLesson';
import OfficeTeammate from '@/pages/OfficeTeammate';
import OfficeAiSupport from '@/pages/OfficeAiSupport';
import OfficeSettings from '@/pages/OfficeSettings';
import MenuLab from '@/pages/MenuLab';
import OfficeTeam from '@/pages/OfficeTeam';
import OfficeAudit from '@/pages/OfficeAudit';
import Security from '@/pages/Security';

export function OfficeApp() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        {/* Side-menu design lab: renders without the app chrome so the
            candidate menus are the only chrome on screen. */}
        <Route path="/menu" component={MenuLab} />
        <Route>
          <Shell>
            <PatientRouteScrollBehavior />
            <Switch>
              <Route path="/" component={Overview} />
              <Route path="/patients" component={Patients} />
              <Route path="/patients/:id" component={PatientDetail} />
              <Route path="/analytics" component={Analytics} />
              <Route path="/leaderboard" component={Leaderboard} />
              <Route path="/subscriptions" component={Subscriptions} />
              <Route path="/training" component={OfficeTraining} />
              {/* Literal /training/team must outrank the :courseId catch-all. */}
              <Route path="/training/team/:viewerId" component={OfficeTeammate} />
              <Route path="/training/:courseId/videos/:videoId" component={OfficeTrainingLesson} />
              <Route path="/training/:courseId" component={OfficeTrainingCourse} />
              <Route path="/ai-support" component={OfficeAiSupport} />
              <Route path="/settings" component={OfficeSettings} />
              <Route path="/team" component={OfficeTeam} />
              <Route path="/audit" component={OfficeAudit} />
              <Route path="/security" component={Security} />
              <Route component={NotFound} />
            </Switch>
          </Shell>
        </Route>
      </Switch>
    </RoutedErrorBoundary>
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
