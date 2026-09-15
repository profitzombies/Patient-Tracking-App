/**
 * HQ drill-in: one provider account's office dashboard inside the admin area.
 *
 * Mounted with `nest` under /admin/accounts/:id/office, so the entire office
 * app (relative routes and all) runs beneath this prefix while a persistent
 * "Viewing as" banner sits above it. ProviderScopeProvider is what scopes the
 * office screens to this account — the screens themselves are the exact
 * components the office persona uses, not copies.
 */
import { Link, Redirect, useParams } from 'wouter';
import { ArrowLeft, Eye } from 'lucide-react';
import { BTN_SECONDARY } from '@/components/patient/heritage';
import { AccountLockedChip } from '@/components/admin/primitives';
import { ProviderScopeProvider } from '@/contexts/provider-scope';
import { useAccountLocks } from '@/contexts/account-locks';
import { useHqData } from '@/contexts/hq-data';
import { OfficeApp, RoutedErrorBoundary } from '@/OfficeApp';

export default function OfficeDrillIn() {
  const { id } = useParams<{ id: string }>();
  const { findAccount, accountsStatus } = useHqData();
  const { isLocked } = useAccountLocks();
  const account = findAccount(id);

  // A direct load or refresh of a drill-in URL arrives before the account
  // list has resolved; hold the frame instead of bouncing to the list.
  if (!account && accountsStatus === 'loading') {
    return <div className="h-[100dvh] bg-background" aria-busy="true" data-testid="drillin-loading" />;
  }
  // Stale or hand-typed URL: land back on the accounts list, not a dead end.
  if (!account) return <Redirect to="~/admin/accounts" replace />;

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      {/* "Viewing as" banner — always visible above the drilled-in office. */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 bg-navy px-4 py-2.5 text-brand-foreground md:px-6"
        data-testid="banner-viewing-as"
      >
        <Eye size={14} className="shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-xs leading-snug">
          <b className="font-semibold">Viewing as {account.officeName}</b>
          <span className="ml-2 hidden opacity-75 sm:inline">
            Provider code {account.providerCode} · {account.providerName}
          </span>
        </p>
        {/* HQ can drill in while locked — the lock only shuts out the provider side. */}
        {isLocked(account.id) && <AccountLockedChip testId="chip-drillin-locked" />}
        <Link
          href={`~/admin/accounts/${account.id}`}
          data-testid="link-back-to-hq"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-brand-foreground/30 bg-brand-foreground/10 px-2.5 text-[11px] font-semibold text-brand-foreground transition hover:bg-brand-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-foreground/60"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          Back to HQ
        </Link>
      </div>

      {/* The office app fills the rest of the column; its Shell switches to
          h-full so the banner + dashboard share the viewport without double
          scrollbars. */}
      <div className="min-h-0 flex-1">
        <RoutedErrorBoundary>
          <ProviderScopeProvider account={account}>
            <OfficeApp />
          </ProviderScopeProvider>
        </RoutedErrorBoundary>
      </div>
    </div>
  );
}
