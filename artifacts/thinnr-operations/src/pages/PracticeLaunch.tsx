import { type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useLaunchData } from '@/hooks/use-launch';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { useSession } from '@/contexts/session';
import { LaunchScreen } from '@/pages/LaunchScreen';
import { BTN_PRIMARY, BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';

export function launchRecoveryPath(path: string) {
  return path === '/security' || path === '/help' || path === '/ai-support';
}
export function PracticeLaunchGuard({ children }: { children: ReactNode }) {
  const scope = useLiveOfficeScope();
  if (scope.isResolving) return <p role="status" className="p-6 text-sm text-muted-foreground">Checking your practice session…</p>;
  if (!scope.liveEnabled) return <>{children}</>;
  return <LaunchDataResolver key={`${scope.authUserId}:${scope.liveOffice}`}>{children}</LaunchDataResolver>;
}

function LaunchDataResolver({ children }: { children: ReactNode }) {
  const query = useLaunchData();
  const { signOut } = useSession();
  const [location] = useLocation();
  const data = query.data;
  const refresh = () => { void query.refetch(); };
  // Never mount operational children during failed or unresolved eligibility.
  if (query.isPending || query.isError || !data) return <div className="mx-auto max-w-xl space-y-4 p-6">
    <h1 className="font-serif text-2xl font-bold text-navy">{query.isPending ? 'Checking practice setup…' : 'Practice setup could not be loaded'}</h1>
    {query.isError && <p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : 'Try again to continue safely.'}</p>}
    <div className="flex gap-3"><button className={`${BTN_SECONDARY} h-10 px-4`} onClick={refresh}>Try again</button><button className={`${BTN_SECONDARY} h-10 px-4`} onClick={signOut}>Sign out</button></div>
  </div>;
  // HQ looking into an office is never held at that office's setup screen: it
  // cannot confirm anything here (every write is owner-only), so the gate would
  // only hide the account it came to inspect. Office staff stay behind it —
  // `hqInspection` is the server's word for the caller, not a client guess.
  const incomplete = data.required && !data.completedAt && !data.hqInspection;
  const isSetup = location === '/setup';
  const isHelp = location === '/help';
  const showTools = isSetup || isHelp || location === '/settings' || incomplete;
  return <>
    {showTools && <div className="border-b border-border bg-sidebar px-4 py-3">
      <nav aria-label="Practice launch" className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <Link href="/setup" className={`${BTN_SECONDARY} h-9 px-3`}>Practice setup</Link>
        <button className={`${BTN_SECONDARY} h-9 px-3`} disabled={query.isFetching} onClick={refresh}>Refresh setup status</button>
        <button className={`${BTN_SECONDARY} h-9 px-3`} onClick={signOut}>Sign out</button>
      </nav>
    </div>}
    {isSetup || (incomplete && !launchRecoveryPath(location))
      ? <LaunchScreen key={data.office.providerId} launchData={data} />
      : isHelp ? <div className="mx-auto max-w-5xl p-5"><SectionCard title="Practice help"><div className="space-y-3 p-5 text-sm"><p>For more help, open THINNR support.</p><Link href="/ai-support" className={`${BTN_SECONDARY} h-10 px-4`}>Open support</Link></div></SectionCard></div>
        : children}
  </>;
}