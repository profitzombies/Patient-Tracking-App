/**
 * Page scaffolding shared by every HQ payments page: the permission gate,
 * the header with sandbox badge and section tabs, and the clickable-row
 * helpers. Lives apart from the pages so new pages (activity, product
 * editor) reuse the exact same chrome.
 */
import { Link, useLocation, useSearch } from 'wouter';
import { AdminPage, PageHeader, PreviewBanner, UnauthorizedState } from '@/components/admin/primitives';
import { SandboxBadge } from '@/components/billing/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/contexts/session';
import { useHqBillingScope } from '@/hooks/use-billing';
import { canHq } from '@/data/hq/team';

/** Section tabs under the header. Paths are base-relative (the area is nest-mounted). */
export const PAYMENT_SECTIONS = [
  { path: '/', label: 'Overview' },
  { path: '/activity', label: 'Activity' },
  { path: '/transactions', label: 'Transactions' },
  { path: '/fulfillment', label: 'Fulfillment' },
  { path: '/subscriptions', label: 'Subscriptions' },
  { path: '/providers', label: 'Providers' },
  { path: '/catalog', label: 'Product catalog' },
] as const;

export function Gate({ children }: { children: (demo: boolean, canWrite: boolean) => React.ReactNode }) {
  const scope = useHqBillingScope();
  const { hqRole } = useSession();
  if (scope.isResolving)
    return (
      <AdminPage>
        <Skeleton className="h-40 w-full" />
      </AdminPage>
    );
  const effectiveRole = scope.isDemo ? 'Super Admin' : hqRole;
  if (!canHq(effectiveRole, 'payments')) return <UnauthorizedState role={effectiveRole} />;
  return <>{children(scope.isDemo, effectiveRole === 'Super Admin' || effectiveRole === 'Admin')}</>;
}

export function SectionTabs() {
  const [location] = useLocation();
  return (
    <nav aria-label="Payments sections" className="mb-5 -mt-2 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
      {PAYMENT_SECTIONS.map((section) => {
        const active = section.path === '/' ? location === '/' || location === '' : location === section.path || location.startsWith(`${section.path}/`);
        return (
          <Link
            key={section.path}
            href={section.path}
            aria-current={active ? 'page' : undefined}
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
  kicker = 'Provider payments',
  tabs = true,
  back,
}: {
  title: string;
  sub: string;
  sandbox?: boolean;
  action?: React.ReactNode;
  kicker?: string;
  /** Detail pages hide the section tabs and show a back link instead. */
  tabs?: boolean;
  back?: { href: string; label: string };
}) {
  return (
    <>
      {back && (
        <Link href={back.href} className="mb-3 inline-flex text-xs font-semibold text-primary hover:underline">
          {back.label}
        </Link>
      )}
      <PageHeader
        kicker={kicker}
        title={title}
        sub={sub}
        className={tabs ? 'mb-4' : undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SandboxBadge sandbox={sandbox} />
            {action}
          </div>
        }
      />
      {tabs && <SectionTabs />}
    </>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry(): void }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
      {error instanceof Error ? error.message : 'Payments could not be loaded.'}{' '}
      <button className="ml-1 underline" onClick={retry}>
        Try again
      </button>
    </div>
  );
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

/** Pointer-only row click: real links inside the row keep working, text selection and modifier keys are respected. */
export function clickable(navigate: (to: string) => void, href: string) {
  return (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as Element).closest('a, button, input, select, textarea') || window.getSelection()?.toString())
      return;
    navigate(href);
  };
}

export function Preview() {
  return <PreviewBanner>Live payments appear here once HQ is signed in</PreviewBanner>;
}

/** Query string as the single source of truth for list filters. */
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
