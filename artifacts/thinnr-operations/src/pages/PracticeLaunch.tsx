import { type ReactNode, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useLaunchData, useLaunchWrite, type LaunchState } from '@/hooks/use-launch';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { useSession } from '@/contexts/session';
import { LaunchScreen } from '@/pages/LaunchScreen';
import { LaunchTourBoundary } from '@/pages/LaunchTourBoundary';
import { BTN_PRIMARY, BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';

export function launchRecoveryPath(path: string) {
  return path === '/security' || path === '/payments/get-paid' || path === '/help' || path === '/ai-support';
}
export function PracticeLaunchGuard({ children }: { children: ReactNode }) {
  const scope = useLiveOfficeScope();
  if (scope.isResolving) return <p role="status" className="p-6 text-sm text-muted-foreground">Checking your practice session…</p>;
  if (!scope.liveEnabled) return <>{children}</>;
  return <LaunchDataResolver key={`${scope.authUserId}:${scope.liveOffice}`}>{children}</LaunchDataResolver>;
}

function LaunchDataResolver({ children }: { children: ReactNode }) {
  const query = useLaunchData();
  const { signOut, authRole } = useSession();
  const [location, navigate] = useLocation();
  const [exited, setExited] = useState(false);
  const [offered, setOffered] = useState(false);
  const [error, setError] = useState('');
  const write = useLaunchWrite('tour');
  const data = query.data;
  const refresh = () => { void query.refetch(); };
  // Never mount operational children during failed or unresolved eligibility.
  if (query.isPending || query.isError || !data) return <div className="mx-auto max-w-xl space-y-4 p-6">
    <h1 className="font-serif text-2xl font-bold text-navy">{query.isPending ? 'Checking practice setup…' : 'Practice setup could not be loaded'}</h1>
    {query.isError && <p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : 'Try again to continue safely.'}</p>}
    <div className="flex gap-3"><button className={`${BTN_SECONDARY} h-10 px-4`} onClick={refresh}>Try again</button><button className={`${BTN_SECONDARY} h-10 px-4`} onClick={signOut}>Sign out</button></div>
  </div>;
  const incomplete = data.required && !data.completedAt;
  const tourAllowed = authRole !== 'hq_admin';
  const start = async (restart = false) => {
    setError('');
    try {
      const result = await write.save({ step: restart ? 0 : data.tour.step, status: 'active' });
      if (result) { setExited(false); setOffered(false); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not start the tour.'); }
  };
  const exit = () => { setExited(true); setOffered(false); navigate(incomplete ? '/setup' : '/'); };
  if (data.tour.status === 'active' && !exited && tourAllowed) return <LaunchTourBoundary launchData={data} onExit={exit} />;
  const isSetup = location === '/setup';
  const isHelp = location === '/help';
  const showOffer = offered || Boolean(data.completedAt && data.required && data.tour.status === 'not_started');
  const showTools = isSetup || isHelp || location === '/settings' || incomplete || showOffer;
  return <>
    {showTools && <div className="border-b border-border bg-sidebar px-4 py-3">
      <nav aria-label="Practice launch" className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <Link href="/setup" className={`${BTN_SECONDARY} h-9 px-3`}>Practice setup</Link>
        {tourAllowed && <button className={`${BTN_SECONDARY} h-9 px-3`} disabled={write.isPending} onClick={() => void start(data.tour.status === 'completed' || data.tour.status === 'skipped')}>{data.tour.status === 'active' ? 'Resume sample tour' : 'Replay / start sample tour'}</button>}
        <button className={`${BTN_SECONDARY} h-9 px-3`} disabled={query.isFetching} onClick={refresh}>Refresh setup status</button>
        <button className={`${BTN_SECONDARY} h-9 px-3`} onClick={signOut}>Sign out</button>
      </nav>{error && <p role="alert" className="mx-auto mt-3 max-w-5xl text-sm text-destructive">{error}</p>}
    </div>}
    {showOffer && tourAllowed && <div className="mx-auto max-w-5xl p-4"><TourOffer data={data} busy={write.isPending} onStart={() => void start()} onSkip={async () => {
      try { await write.save({ step: data.tour.step, status: 'skipped' }); setOffered(false); navigate('/'); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save your choice.'); }
    }} /></div>}
    {!incomplete && location === '/' && !showOffer && (exited || data.tour.status === 'completed' || data.tour.status === 'skipped') && (
      <div className="mx-auto max-w-5xl p-4">
        <SectionCard title="Ready for your real practice" sub="The sample tour did not add any patients, messages, transactions or training completions.">
          <div className="space-y-3 p-5 text-sm">
            <p>Start with one patient invitation, invite a teammate, or browse training at your own pace.</p>
            <div className="flex flex-wrap gap-3">
              <Link href="/patients" className={`${BTN_PRIMARY} h-10 px-4`}>Open patients and invitations</Link>
              <Link href="/team" className={`${BTN_SECONDARY} h-10 px-4`}>Manage teammates</Link>
              <Link href="/training" className={`${BTN_SECONDARY} h-10 px-4`}>Browse training</Link>
              <Link href="/help" className={`${BTN_SECONDARY} h-10 px-4`}>Help and tour</Link>
            </div>
          </div>
        </SectionCard>
      </div>
    )}
    {isSetup || (incomplete && !launchRecoveryPath(location))
      ? <LaunchScreen key={data.office.providerId} launchData={data} allowTour={tourAllowed} onTour={() => { setOffered(true); if (tourAllowed && !data.canEdit) void start(); }} />
      : isHelp ? <div className="mx-auto max-w-5xl p-5"><SectionCard title="Practice help"><div className="space-y-3 p-5 text-sm"><p>Resume setup or replay the sample tour using the controls above. For more help, open THINNR support.</p><Link href="/ai-support" className={`${BTN_SECONDARY} h-10 px-4`}>Open support</Link></div></SectionCard></div>
        : children}
  </>;
}
function TourOffer({ data, busy, onStart, onSkip }: { data: LaunchState; busy: boolean; onStart: () => void; onSkip: () => void }) {
  return <SectionCard title="Your next step: explore with sample data" sub="An optional six-step tour. No real patients, messages or payments.">
    <div className="space-y-3 p-5 text-sm"><p>{data.payments.state === 'pending' ? 'Stripe is still verifying your account. You can learn the tools while you wait.' : 'Get comfortable with the tools before working with your patients.'}</p>
      <div className="flex flex-wrap gap-3"><button className={`${BTN_PRIMARY} h-10 px-4`} disabled={busy} onClick={onStart}>Start guided tour</button><button className={`${BTN_SECONDARY} h-10 px-4`} disabled={busy} onClick={onSkip}>Skip tour</button></div></div>
  </SectionCard>;
}