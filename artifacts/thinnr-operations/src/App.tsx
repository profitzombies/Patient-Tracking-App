/**
 * App entry — providers, the real-auth front door, and the two persona areas.
 *
 * The app opens on a real Supabase sign-in (email or phone + password), with
 * an explicit "Explore the demo" bypass: office staff get the
 * operations desk exactly as it runs standalone, THINNR HQ admins get the
 * umbrella above it. A signed-in account's profile role picks the area;
 * signed-in patients are pointed at the mobile app. Gating is absolute in both directions — the office
 * persona can never render an /admin URL (it bounces to the dashboard), and
 * the admin persona always lands inside /admin (any other URL bounces to the
 * HQ overview). The office drill-in mounts the office app under
 * /admin/accounts/:id/office via a nested route, outside the admin shell so
 * the office keeps its own chrome under the "Viewing as" banner.
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Redirect,
  Route,
  Switch,
  Router as WouterRouter,
} from 'wouter';

import { OfficeApp, RoutedErrorBoundary } from '@/OfficeApp';
import SignIn from '@/pages/SignIn';
import ClaimAccount from '@/pages/ClaimAccount';
import {
  AccountLockedScreen,
  BootScreen,
  ClaimedWorkspaceScreen,
  PatientOnWebNotice,
  ProfileErrorScreen,
} from '@/pages/AuthScreens';
import { AdminShell } from '@/components/admin/AdminShell';
import HqOverview from '@/pages/admin/HqOverview';
import Accounts from '@/pages/admin/Accounts';
import AccountDetail from '@/pages/admin/AccountDetail';
import OfficeDrillIn from '@/pages/admin/OfficeDrillIn';
import Conversations from '@/pages/admin/Conversations';
import Team from '@/pages/admin/Team';
import OrgSettings from '@/pages/admin/OrgSettings';
import TrainingDashboard from '@/pages/admin/training/TrainingDashboard';
import TrainingCourses from '@/pages/admin/training/TrainingCourses';
import CourseEditor from '@/pages/admin/training/CourseEditor';
import VideoEditor from '@/pages/admin/training/VideoEditor';
import TrainingViewers from '@/pages/admin/training/TrainingViewers';
import ViewerProfile from '@/pages/admin/training/ViewerProfile';
import TrainingAnalytics from '@/pages/admin/training/TrainingAnalytics';
import LearnerPreview from '@/pages/admin/training/LearnerPreview';
import KnowledgeBase from '@/pages/admin/KnowledgeBase';
import SupportTestBench from '@/pages/admin/SupportTestBench';
import Files from '@/pages/admin/Files';
import { PatientSessionProvider } from '@/contexts/patient-session';
import { DateRangeProvider } from '@/contexts/date-range';
import { SessionProvider, useSession } from '@/contexts/session';
import { AccountLocksProvider, useAccountLocks } from '@/contexts/account-locks';
import { HqDataProvider } from '@/contexts/hq-data';
import { TrainingDataProvider } from '@/contexts/training-data';
import { ProviderScopeProvider } from '@/contexts/provider-scope';
import { findSeededAccount } from '@/data/hq/accounts';

const queryClient = new QueryClient();

/** Everything a signed-in HQ admin can reach. */
function AdminArea() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        {/* Drill-in first: it must win over the general admin chrome below,
            and it mounts the office app (with its own Shell) via `nest`. */}
        <Route path="/admin/accounts/:id/office" nest component={OfficeDrillIn} />
        {/* Learner-facing course preview renders without the admin chrome,
            like the office drill-in — it simulates what an office teammate
            sees after opening the share link. */}
        <Route path="/admin/training/preview/:courseId" component={LearnerPreview} />
        <Route>
          <AdminShell>
            <Switch>
              <Route path="/admin" component={HqOverview} />
              <Route path="/admin/accounts" component={Accounts} />
              <Route path="/admin/accounts/:id" component={AccountDetail} />
              <Route path="/admin/conversations" component={Conversations} />
              <Route path="/admin/team" component={Team} />
              <Route path="/admin/settings" component={OrgSettings} />
              <Route path="/admin/training" component={TrainingDashboard} />
              <Route path="/admin/training/courses" component={TrainingCourses} />
              <Route path="/admin/training/courses/:courseId/videos/:videoId" component={VideoEditor} />
              <Route path="/admin/training/courses/:courseId" component={CourseEditor} />
              <Route path="/admin/training/viewers" component={TrainingViewers} />
              <Route path="/admin/training/viewers/:viewerId" component={ViewerProfile} />
              <Route path="/admin/training/analytics" component={TrainingAnalytics} />
              <Route path="/admin/knowledge" component={KnowledgeBase} />
              <Route path="/admin/support-test" component={SupportTestBench} />
              <Route path="/admin/files" component={Files} />
              {/* Admin persona anywhere else (including office URLs) → HQ. */}
              <Route>
                <Redirect to="/admin" replace />
              </Route>
            </Switch>
          </AdminShell>
        </Route>
      </Switch>
    </RoutedErrorBoundary>
  );
}

/**
 * Routes by session. Real auth resolves first — booting, profile trouble,
 * or a signed-in patient pre-empt everything. Otherwise the resolved
 * persona (real role, or the demo bypass) locks each area exactly as before.
 */
/**
 * The office area, scoped to the signed-in staffer's own provider account
 * when their profile carries one that matches a seeded office. The demo
 * bypass (and any unmatched account code) keeps the unscoped office exactly
 * as it always ran.
 */
function ScopedOfficeApp() {
  const { authStatus, providerAccountCode } = useSession();
  const { isLocked } = useAccountLocks();
  const account = useMemo(
    () =>
      authStatus === 'signed-in' && providerAccountCode
        ? (findSeededAccount(providerAccountCode) ?? null)
        : null,
    [authStatus, providerAccountCode],
  );
  // THINNR's account lock outranks everything office-side: locked staff see
  // the blocked notice, never the workspace. Keyed on the raw profile code
  // (not the resolved seeded account) so a lock also blocks codes without a
  // seeded office. The demo bypass never trips this — it isn't signed in —
  // and this gate is UX: row level security is what actually closes the
  // office's data server-side while locked.
  if (authStatus === 'signed-in' && providerAccountCode && isLocked(providerAccountCode)) {
    return <AccountLockedScreen />;
  }
  if (!account) return <OfficeApp />;
  // Standalone scoped desk (real staff sign-in): the Shell switches to h-full
  // in scoped mode because the HQ drill-in sizes it under its banner. Standalone
  // must provide that viewport-height frame itself — without it the whole
  // document scrolls, unpinning the header/tab bar and making mobile Safari's
  // collapsing URL bar reflow the page on every scroll.
  return (
    <ProviderScopeProvider account={account}>
      <div className="h-[100dvh]">
        <OfficeApp />
      </div>
    </ProviderScopeProvider>
  );
}

function PersonaRouter() {
  const { persona, authStatus, authRole, roleStatus, claimedWorkspace } = useSession();

  if (authStatus === 'loading') return <BootScreen />;
  if (authStatus === 'signed-in') {
    if (roleStatus === 'idle' || roleStatus === 'loading') return <BootScreen />;
    if (roleStatus === 'error') return <ProfileErrorScreen />;
    if (authRole === 'patient') return <PatientOnWebNotice />;
    if (claimedWorkspace) return <ClaimedWorkspaceScreen />;
  }

  if (persona === null) {
    return (
      <Switch>
        <Route path="/claim" component={ClaimAccount} />
        <Route component={SignIn} />
      </Switch>
    );
  }

  if (persona === 'office') {
    return (
      <TrainingDataProvider>
        <Switch>
          {/* Office staff can never reach the admin umbrella. */}
          <Route path="/admin" nest>
            <Redirect to="~/" replace />
          </Route>
          <Route>
            <ScopedOfficeApp />
          </Route>
        </Switch>
      </TrainingDataProvider>
    );
  }

  return (
    <HqDataProvider>
      <TrainingDataProvider>
        <AdminArea />
      </TrainingDataProvider>
    </HqDataProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
          <SessionProvider>
            <PatientSessionProvider>
              <DateRangeProvider>
                <AccountLocksProvider>
                  <PersonaRouter />
                </AccountLocksProvider>
              </DateRangeProvider>
            </PatientSessionProvider>
          </SessionProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
