import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ChevronDown,
  LogOut,
  Plus,
  Search,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';
import { usePatientsBadge } from '@/hooks/use-patients-badge';
import { matchesPhoneQuery } from '@/lib/phone-digits';
import {
  findActiveOfficeNavItem,
  isOfficeMenuPathActive,
  OFFICE_NAV_ITEMS,
  OFFICE_NAV_SECTION_DEFS,
  RESTRICTED_OFFICE_NAV_SECTION_DEFS,
  restrictedOfficeNavItems,
  useOfficeIdentity,
} from '@/components/layout/nav-config';
import { useOfficeRestriction } from '@/contexts/office-restriction';
import { RestrictedBanner } from '@/components/office/RestrictedAccess';
import { groupMenuSections, SideMenu, useMenuMode } from '@/components/layout/side-menu';
import { AttentionBell } from '@/components/office/AttentionBell';
import { IdleTimeoutDialog } from '@/components/layout/IdleTimeoutDialog';

function ActionButton({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-card text-primary shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { toast } = useToast();
  // HQ drill-in scope: null in the standalone office demo. When scoped, the
  // shell rebrands to the drilled-in office and fits under the HQ banner.
  const scope = useProviderScope();
  const { signOut, authStatus } = useSession();
  // Patients badge + quick-search source: the live roster summary (same
  // cached query the Patients page reads) or the seeded roster in the demo.
  const { badge: patientsBadge, liveEnabled, livePatients, liveRosterReady, demoPatients } = usePatientsBadge();
  const [menuMode, setMenuMode] = useMenuMode();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLAnchorElement>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const isHistoryNavigationRef = useRef(false);

  // One shared item list drives this menu and the /menu design lab. An office
  // narrowed for nonpayment sees only what it can still use.
  const { restricted } = useOfficeRestriction();
  const navItems = restricted ? restrictedOfficeNavItems() : OFFICE_NAV_ITEMS;
  const activeItem = findActiveOfficeNavItem(location);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeItem.path]);

  useEffect(() => {
    const handlePopState = () => {
      isHistoryNavigationRef.current = true;
    };
    window.history.scrollRestoration = 'manual';
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const frame = window.requestAnimationFrame(() => {
      const nextPosition = isHistoryNavigationRef.current
        ? scrollPositionsRef.current.get(location) ?? 0
        : 0;
      container.scrollTo({ top: nextPosition, behavior: 'auto' });
      isHistoryNavigationRef.current = false;
    });
    const handleScroll = () => scrollPositionsRef.current.set(location, container.scrollTop);
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [location]);

  useEffect(() => {
    document.title = scope
      ? `${activeItem.label} — ${scope.officeName} · THINNR HQ view`
      : `${activeItem.label} — THINNR Med Spa Operations`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute('content', authStatus === 'signed-out'
      ? `Synthetic THINNR med spa operations demo: ${activeItem.label.toLowerCase()}, patient progress, outcomes, and recurring deliveries.`
      : `THINNR med spa operations: ${activeItem.label.toLowerCase()}.`);
  }, [activeItem.label, authStatus, scope]);

  // The account chip identity is shared with the /menu design lab.
  const { accountName, accountRole, initials, workspaceLabel } = useOfficeIdentity();

  // The Porcelain menu: shared sections, live links, real sign-out.
  const menuSections = groupMenuSections(
    navItems,
    restricted ? RESTRICTED_OFFICE_NAV_SECTION_DEFS : OFFICE_NAV_SECTION_DEFS,
  ).map((section) => ({
    label: section.label,
    items: section.items.map((item) => ({
      path: item.path,
      label: item.label,
      icon: item.icon,
      // Total patients normally; the amber evaluator-flagged count when anyone
      // needs attention, with the link then opening the roster attention-first.
      href: item.path === '/patients' ? patientsBadge.href : undefined,
      count: item.path === '/patients' ? patientsBadge.count : undefined,
      countTone: item.path === '/patients' ? patientsBadge.tone : undefined,
      countLabel: item.path === '/patients' ? patientsBadge.label : undefined,
      children: item.children?.map((child) => ({
        path: child.path,
        label: child.label,
        testId: `link-office-nav-${child.path.split('/').filter(Boolean).join('-')}`,
      })),
    })),
  }));

  const handleSearchSubmit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const rawQuery = searchQuery.trim();
      const normalizedQuery = rawQuery.toLowerCase();
      // Signed-in offices match their live roster (name, email, phone, id);
      // only the signed-out persona ever matches the seeded demo roster.
      const match = !normalizedQuery
        ? undefined
        : liveEnabled
          ? (livePatients ?? []).find((patient) =>
              patient.name.toLowerCase().includes(normalizedQuery) ||
              (patient.email ?? '').toLowerCase().includes(normalizedQuery) ||
              matchesPhoneQuery(rawQuery, patient.phone, patient.phoneDisplay) ||
              patient.id.toLowerCase() === normalizedQuery
            )
          : demoPatients.find((patient) =>
              patient.name.toLowerCase().includes(normalizedQuery) ||
              patient.email.toLowerCase().includes(normalizedQuery) ||
              matchesPhoneQuery(rawQuery, patient.phone) ||
              patient.id.toLowerCase() === normalizedQuery
            );
      if (match) {
        navigate(`/patients/${match.id}`);
        toast({ title: `${match.name} opened`, description: liveEnabled ? 'Matched from your patient roster.' : 'Matched from the synthetic patient roster.' });
      } else if (liveEnabled) {
        navigate('/patients');
        toast({
          title: 'Patient roster opened',
          description: !normalizedQuery
            ? 'Search the roster by name, email, or phone.'
            : liveRosterReady
              ? 'No exact match was found. Use the roster search and filters to continue.'
              : 'The roster is still loading. Use the roster search once it appears.',
        });
      } else {
        navigate('/patients');
        toast({ title: 'Patient roster opened', description: normalizedQuery ? 'No exact match was found. Use the roster filters to continue.' : 'Search the full synthetic roster.' });
      }
      setSearchOpen(false);
      setSearchQuery('');
    }
  };

  return (
    <div className={`${scope ? 'h-full' : 'h-[100dvh]'} flex max-w-full overflow-hidden bg-background font-sans text-foreground`}>
      <IdleTimeoutDialog />
      {/* Sidebar — the Porcelain menu (hidden on phones, which use the tab bar) */}
      <SideMenu
        mode={menuMode}
        onModeChange={setMenuMode}
        sections={menuSections}
        isItemActive={(path) => isOfficeMenuPathActive(path, location)}
        brandSubtitle={workspaceLabel}
        cta={restricted ? undefined : { label: 'Add patient', icon: Plus, href: '/patients' }}
        accountName={accountName}
        accountRole={accountRole}
        accountInitials={initials}
        onSignOut={
          scope
            ? undefined
            : /* The HQ drill-in exits via its own "Back to HQ" banner instead. */
              () => {
                signOut();
                navigate('/');
              }
        }
        onSettings={restricted ? undefined : () => navigate('/settings')}
      />

      {/* Main Content Area */}
      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 h-[68px] items-center justify-between gap-2 border-b border-border bg-paper-alt px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">Operations</span>
            <span className="text-muted-foreground/40 hidden sm:inline">/</span>
            <strong className="truncate font-serif text-[15px] font-bold tracking-[.01em] text-navy">{activeItem.label}</strong>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DateRangeControl />
            {/* Roster search and the attention bell both open blocked areas
                while the office is narrowed for nonpayment. */}
            {!restricted && searchOpen && (
              <input
                autoFocus
                placeholder="Search patient or ID..."
                data-testid="input-quick-search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-9 w-32 rounded-md border border-border bg-card px-3 text-xs shadow-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring sm:w-48"
                onKeyDown={handleSearchSubmit}
              />
            )}
            {!restricted && (
              <ActionButton label="Search" onClick={() => setSearchOpen(!searchOpen)}>
                <Search size={16} />
              </ActionButton>
            )}
            {!restricted && <AttentionBell />}
            {!scope && (
              /* Standalone personas sign out here; the HQ drill-in exits via
                 its own "Back to HQ" banner instead. */
              <ActionButton
                label="Sign out"
                onClick={() => {
                  signOut();
                  navigate('/');
                }}
              >
                <LogOut size={16} />
              </ActionButton>
            )}

            <button
              onClick={() => toast({ title: "Account menu opened" })}
              className="ml-1 flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground shadow-xs">
                {initials}
              </span>
              <span className="hidden text-left md:block">
                <b className="block text-xs font-semibold text-navy">{accountName}</b>
                <small className="text-[10px] text-muted-foreground">{accountRole}</small>
              </span>
              <ChevronDown size={13} className="text-muted-foreground" />
            </button>
          </div>
        </header>

        <RestrictedBanner />

        {/* The scrollable content */}
        <div ref={scrollContainerRef} data-app-scroll className="flex-1 overflow-x-hidden overflow-y-auto">
          {children}
        </div>

        {/* Phone tab bar: nine destinations don't fit a 390px row, so the bar
            scrolls sideways and keeps the active tab in view. */}
        <nav aria-label="Mobile primary navigation" className="flex shrink-0 overflow-x-auto border-t border-border bg-paper-alt [scrollbar-width:none] md:hidden">
          {navItems.map((item) => {
            const isActive = activeItem.path === item.path;
            const mobileLabel = item.mobileLabel;
            return (
              <Link
                key={item.path}
                href={item.path}
                aria-current={isActive ? 'page' : undefined}
                ref={isActive ? activeTabRef : undefined}
                className={`flex min-h-14 min-w-[64px] flex-1 flex-col items-center justify-center gap-1 border-t-2 px-1 py-2 text-center text-[9px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive
                    ? 'border-primary bg-accent text-navy'
                    : 'border-transparent text-muted-foreground hover:bg-secondary'
                }`}
              >
                <span className={isActive ? 'text-primary' : undefined}><item.icon size={16} /></span>
                <span className="leading-tight">{mobileLabel}</span>
              </Link>
            );
          })}
        </nav>

      </section>
    </div>
  );
}
