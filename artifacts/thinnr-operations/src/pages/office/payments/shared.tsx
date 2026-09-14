/**
 * Chrome shared by every office payments page: the page frame, the demo /
 * permission / no-account boundary, the header with the section tab strip,
 * and the small helpers the list pages share. New pages (activity, refunds,
 * fulfillment) reuse this so the whole area reads as one workspace.
 */
import type { ReactNode } from 'react';
import { Link, Redirect, useLocation, useSearch } from 'wouter';
import { ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/admin/primitives';
import { SandboxBadge } from '@/components/billing/primitives';
import { BTN_SECONDARY } from '@/components/patient/heritage';
import { OFFICE_PAYMENTS_SECTIONS } from '@/components/layout/nav-config';
import { useOfficeBillingScope, useOfficeBillingStatus } from '@/hooks/use-billing';
import { BillingApiError } from '@/lib/billing-api';
import type { OfficeBillingStatus } from '@/lib/billing-types';

export const PAGE = 'mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8';
const permissionText = 'Only office owners and admins can manage payments.';

/** The area is nest-mounted at /payments, so tab hrefs are base-relative. */
const SECTIONS = OFFICE_PAYMENTS_SECTIONS.map((section) => ({
  path: section.path === '/payments' ? '/' : section.path.slice('/payments'.length),
  label: section.label,
}));

export function ErrorBox({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-card p-5">
      <p className="text-xs text-destructive">
        {error instanceof Error ? error.message : 'Payments could not be loaded.'}
      </p>
      <button type="button" className={`${BTN_SECONDARY} mt-3 h-8 px-3`} onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function PermissionState() {
  return (
    <div className={PAGE}>
      <div
        role="alert"
        data-testid="status-billing-unauthorized"
        className="rounded-lg border border-card-border bg-card p-7 shadow-soft"
      >
        <ShieldCheck size={18} className="text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-3 font-serif text-xl font-bold text-navy">Payments access is restricted</h1>
        <p className="mt-2 text-xs text-muted-foreground">{permissionText}</p>
      </div>
    </div>
  );
}

export function DemoNotice() {
  return (
    <div
      role="note"
      data-testid="billing-demo-notice"
      className="rounded-md border border-accent-border bg-accent px-4 py-3 text-xs text-foreground"
    >
      Live payments appear here once your office is signed in.
    </div>
  );
}

/**
 * Section tabs under the header. The desktop side menu lists the same
 * sections as a dropdown; on phones (one Payments tab in the bottom bar)
 * this strip is how every sub-page is reached.
 */
export function SectionTabs() {
  const [location] = useLocation();
  return (
    <nav aria-label="Payments sections" className="flex gap-1 overflow-x-auto border-b border-border">
      {SECTIONS.map((section) => {
        const active =
          section.path === '/'
            ? location === '/' || location === ''
            : location === section.path || location.startsWith(`${section.path}/`);
        return (
          <Link
            key={section.path}
            href={section.path}
            aria-current={active ? 'page' : undefined}
            data-testid={`tab-payments-${section.path === '/' ? 'overview' : section.path.slice(1)}`}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-navy'
            }`}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Header({
  title,
  sub,
  sandbox,
  action,
  tabs = true,
  back,
}: {
  title: string;
  sub: string;
  sandbox?: boolean;
  action?: ReactNode;
  /** Detail pages hide the section tabs and show a back link instead. */
  tabs?: boolean;
  back?: { href: string; label: string };
}) {
  return (
    <div>
      {back && (
        <Link href={back.href} className="mb-3 inline-flex text-xs font-semibold text-primary hover:underline">
          {back.label}
        </Link>
      )}
      <PageHeader
        kicker="Payments"
        className={tabs ? 'mb-4' : 'mb-0'}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {title}
            <SandboxBadge sandbox={sandbox} />
          </span>
        }
        sub={sub}
        action={action}
      />
      {tabs && <SectionTabs />}
    </div>
  );
}

export function Boundary({
  children,
  allowNoAccount = false,
  demo,
}: {
  children: (status: OfficeBillingStatus) => ReactNode;
  allowNoAccount?: boolean;
  demo: ReactNode;
}) {
  const scope = useOfficeBillingScope();
  const status = useOfficeBillingStatus({
    retry: (count, error) => !(error instanceof BillingApiError && error.status === 403) && count < 2,
  });
  if (scope.isResolving)
    return (
      <div className={PAGE}>
        <p className="text-xs text-muted-foreground">Checking your sign-in…</p>
      </div>
    );
  if (scope.isDemo) return <>{demo}</>;
  if (!scope.liveEnabled) return <PermissionState />;
  if (status.isPending)
    return (
      <div className={PAGE}>
        <div className="h-28 animate-pulse rounded-lg bg-card" />
      </div>
    );
  if (
    (status.error instanceof BillingApiError && status.error.status === 403) ||
    status.data?.viewer.can_manage === false
  )
    return <PermissionState />;
  if (status.isError || !status.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={status.error} retry={() => void status.refetch()} />
      </div>
    );
  if (!allowNoAccount && status.data.account === null) return <Redirect to="/get-paid" />;
  return <>{children(status.data)}</>;
}

export function demoPage(title: string, body: ReactNode, sub = 'A guided example of your office payment workspace.') {
  return (
    <div className={PAGE}>
      <Header title={title} sub={sub} sandbox />
      <DemoNotice />
      {body}
    </div>
  );
}

/** Query string as the single source of truth for list filters (base-relative). */
export function useUrlFilters(base: string) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    value ? next.set(key, value) : next.delete(key);
    navigate(`${base}${next.toString() ? `?${next}` : ''}`, { replace: true });
  };
  return { params, set };
}

/** Pointer-only row click: real links inside the row keep working, text selection and modifier keys are respected. */
export function clickable(navigate: (to: string) => void, href: string) {
  return (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as Element).closest('a, button, input, select, textarea') || window.getSelection()?.toString())
      return;
    navigate(href);
  };
}

export function RowLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Open
    </Link>
  );
}
