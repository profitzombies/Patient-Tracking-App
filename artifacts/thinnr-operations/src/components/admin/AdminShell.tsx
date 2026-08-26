/**
 * Navigation shell for the THINNR HQ admin umbrella.
 *
 * Mirrors the office Shell's Heritage geometry — the shared Porcelain side
 * menu, 68px header, one scrollable content column, mobile bottom nav,
 * synthetic-data footer — so drilling from HQ into an office feels like
 * moving floors in the same building, not switching apps. Differences are
 * deliberate: HQ pages are anchored to the fixed demo date (no date-range
 * control), the identity block is the HQ owner rather than a provider, and
 * the header carries the sign-out button for the simulated session.
 */
import { ReactNode, useEffect, useRef } from 'react';
import { Link, useLocation } from 'wouter';
import {
  BookOpenText,
  Building2,
  FlaskConical,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Settings2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useSession } from '@/contexts/session';
import { useHqData } from '@/contexts/hq-data';
import { HQ_ADMIN_IDENTITY } from '@/data/hq/team';
import { groupMenuSections, SideMenu, useMenuMode } from '@/components/layout/side-menu';

interface NavItem {
  path: string;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
  preview?: boolean;
}

/** Ordered to match the menu's section grouping, top to bottom. */
const NAV_ITEMS: NavItem[] = [
  { path: '/admin', label: 'Overview', mobileLabel: 'Overview', icon: LayoutDashboard },
  { path: '/admin/accounts', label: 'Provider accounts', mobileLabel: 'Accounts', icon: Building2 },
  { path: '/admin/conversations', label: 'Conversations', mobileLabel: 'Coach', icon: MessagesSquare },
  { path: '/admin/team', label: 'Team', icon: Users },
  { path: '/admin/training', label: 'Training', icon: GraduationCap },
  { path: '/admin/knowledge', label: 'AI Support', mobileLabel: 'Support', icon: BookOpenText },
  { path: '/admin/support-test', label: 'Test AI Support', mobileLabel: 'Test chat', icon: FlaskConical },
  { path: '/admin/files', label: 'Files', icon: FolderOpen, preview: true },
  { path: '/admin/settings', label: 'Settings', icon: Settings2 },
];

const ADMIN_NAV_SECTION_DEFS = [
  { label: 'Dashboard', paths: ['/admin'] },
  { label: 'Operations', paths: ['/admin/accounts', '/admin/conversations', '/admin/team'] },
  { label: 'Learning', paths: ['/admin/training', '/admin/knowledge', '/admin/support-test'] },
  { label: 'Manage', paths: ['/admin/files', '/admin/settings'] },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { signOut } = useSession();
  const { accounts } = useHqData();
  const [menuMode, setMenuMode] = useMenuMode();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Exact match for the overview root, prefix match for everything below it —
  // so /admin/accounts/:id/office still lights up "Provider accounts".
  const activeItem =
    NAV_ITEMS.find((item) => (item.path === '/admin' ? location === '/admin' : location.startsWith(item.path))) ??
    NAV_ITEMS[0];

  // Admin pages are short-lived browse views — landing at the top of each
  // page beats restoring scroll (the office shell keeps its own restoration).
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [location]);

  useEffect(() => {
    document.title = `${activeItem.label} — THINNR HQ Admin`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute(
      'content',
      `Synthetic THINNR HQ admin demo: ${activeItem.label.toLowerCase()} across every provider account.`,
    );
  }, [activeItem.label]);

  const handleSignOut = () => {
    signOut();
    // Persona is gone — the router shows the sign-in chooser at the root.
    navigate('/', { replace: true });
  };

  // The Porcelain menu: admin sections, live links, real sign-out.
  const menuSections = groupMenuSections(NAV_ITEMS, ADMIN_NAV_SECTION_DEFS).map((section) => ({
    label: section.label,
    items: section.items.map((item) => ({
      path: item.path,
      label: item.label,
      icon: item.icon,
      count: item.path === '/admin/accounts' ? accounts.length : undefined,
      tag: item.preview ? 'Preview' : undefined,
      testId: `link-admin-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`,
    })),
  }));

  return (
    <div className="min-h-[100dvh] max-w-full overflow-x-hidden bg-background font-sans text-foreground flex">
      {/* Sidebar — the Porcelain menu (hidden on phones, which use the tab bar) */}
      <SideMenu
        label="Admin sidebar"
        mode={menuMode}
        onModeChange={setMenuMode}
        sections={menuSections}
        isItemActive={(path) => activeItem.path === path}
        brandSubtitle="HQ admin"
        accountName={HQ_ADMIN_IDENTITY.name}
        accountRole={HQ_ADMIN_IDENTITY.title}
        accountInitials={HQ_ADMIN_IDENTITY.initials}
        onSignOut={handleSignOut}
        onSettings={() => navigate('/admin/settings')}
      />

      {/* Main content area */}
      <section className="min-w-0 flex-1 flex flex-col h-[100dvh]">
        <header className="flex shrink-0 h-[68px] items-center justify-between gap-2 border-b border-border bg-paper-alt px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">THINNR HQ</span>
            <span className="text-muted-foreground/40 hidden sm:inline">/</span>
            <strong className="truncate font-serif text-[15px] font-bold tracking-[.01em] text-navy" data-testid="text-admin-breadcrumb">
              {activeItem.label}
            </strong>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleSignOut}
              data-testid="button-signout"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-semibold text-foreground shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut size={14} aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
              <span className="sr-only sm:hidden">Sign out</span>
            </button>

            <div className="ml-1 flex items-center gap-2 rounded-md px-2 py-1.5">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-navy text-[10px] font-bold text-brand-foreground shadow-xs">
                {HQ_ADMIN_IDENTITY.initials}
              </span>
              <span className="hidden text-left md:block">
                <b className="block text-xs font-semibold text-navy">{HQ_ADMIN_IDENTITY.name}</b>
                <small className="text-[10px] text-muted-foreground">{HQ_ADMIN_IDENTITY.title}</small>
              </span>
            </div>
          </div>
        </header>

        {/* The scrollable content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-x-hidden overflow-y-auto">
          {children}
        </div>

        {/* Seven destinations don't fit five fixed columns — the bar scrolls. */}
        <nav aria-label="Mobile primary navigation" className="flex shrink-0 overflow-x-auto border-t border-border bg-paper-alt md:hidden">
          {NAV_ITEMS.map((item) => {
            const isActive = activeItem.path === item.path;
            return (
              <Link
                key={item.path}
                href={item.path}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-14 min-w-[76px] flex-1 flex-col items-center justify-center gap-1 border-t-2 px-1 py-2 text-center text-[9px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive
                    ? 'border-primary bg-accent text-navy'
                    : 'border-transparent text-muted-foreground hover:bg-secondary'
                }`}
              >
                <span className={isActive ? 'text-primary' : undefined}><item.icon size={16} /></span>
                <span className="leading-tight">{item.mobileLabel ?? item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Synthetic data disclaimer footer */}
        <div className="shrink-0 border-t border-border bg-sidebar px-5 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
            Synthetic Demo Data • Not Medical Advice
          </p>
        </div>
      </section>
    </div>
  );
}
