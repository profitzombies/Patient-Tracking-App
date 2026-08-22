import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { Shell } from '@/components/layout/Shell';
import Overview from '@/pages/Overview';
import Patients from '@/pages/Patients';
import PatientDetail from '@/pages/PatientDetail';
import Analytics from '@/pages/Analytics';
import Leaderboard from '@/pages/Leaderboard';
import Subscriptions from '@/pages/Subscriptions';
import { PatientSessionProvider } from '@/contexts/patient-session';

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Shell>
        <PatientRouteScrollBehavior />
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/patients" component={Patients} />
          <Route path="/patients/:id" component={PatientDetail} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/leaderboard" component={Leaderboard} />
          <Route path="/subscriptions" component={Subscriptions} />
          <Route component={NotFound} />
        </Switch>
      </Shell>
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

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
          <PatientSessionProvider>
            <Router />
          </PatientSessionProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
