import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Bell,
  ChevronDown,
  LayoutDashboard,
  Search,
  Settings2,
  Users,
  WalletCards,
  Box,
  Trophy
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { MOCK_PATIENTS } from '@/data/mock-data';
import { DateRangeControl } from '@/components/layout/DateRangeControl';

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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const isHistoryNavigationRef = useRef(false);

  const navItems = [
    { path: '/', label: 'Overview', icon: <LayoutDashboard size={16} /> },
    { path: '/patients', label: 'Patients', icon: <Users size={16} /> },
    { path: '/analytics', label: 'Revenue & Outcomes', icon: <WalletCards size={16} /> },
    { path: '/leaderboard', label: 'Leaderboard', icon: <Trophy size={16} /> },
    { path: '/subscriptions', label: 'Subscriptions', icon: <Box size={16} /> },
  ];

  const activeItem = navItems.find(item => {
    if (item.path === '/') return location === '/';
    return location.startsWith(item.path);
  }) || navItems[0];

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
    document.title = `${activeItem.label} — THINNR Med Spa Operations`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute('content', `Synthetic THINNR med spa operations demo: ${activeItem.label.toLowerCase()}, patient progress, outcomes, and recurring deliveries.`);
  }, [activeItem.label]);

  const handleSearchSubmit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const normalizedQuery = searchQuery.trim().toLowerCase();
      const match = MOCK_PATIENTS.find((patient) =>
        patient.name.toLowerCase().includes(normalizedQuery) ||
        patient.email.toLowerCase().includes(normalizedQuery) ||
        patient.id.toLowerCase() === normalizedQuery
      );
      if (match && normalizedQuery) {
        navigate(`/patients/${match.id}`);
        toast({ title: `${match.name} opened`, description: 'Matched from the synthetic patient roster.' });
      } else {
        navigate('/patients');
        toast({ title: 'Patient roster opened', description: normalizedQuery ? 'No exact match was found. Use the roster filters to continue.' : 'Search the full synthetic roster.' });
      }
      setSearchOpen(false);
      setSearchQuery('');
    }
  };

  return (
    <div className="min-h-[100dvh] max-w-full overflow-x-hidden bg-background font-sans text-foreground flex">
      {/* Sidebar - Hidden on very small screens, visible md and up */}
      <aside className="hidden w-[252px] shrink-0 border-r border-sidebar-border bg-sidebar px-5 py-5 md:flex md:flex-col">
        <button
          onClick={() => toast({ title: "Workspace Switcher", description: "Not implemented in mock." })}
          className="mb-9 flex items-center gap-3 rounded-sm border-b border-sidebar-border px-2 pb-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-navy text-brand-foreground shadow-soft">
            <span className="text-[11px] font-bold tracking-[.04em]">TH</span>
          </span>
          <span className="min-w-0 whitespace-nowrap">
            <strong className="block font-serif text-[15px] font-bold tracking-[.01em] text-navy">THINNR</strong>
            <span className="text-[10px] uppercase tracking-[.14em] text-muted-foreground">operations desk</span>
          </span>
          <ChevronDown size={14} className="ml-auto text-muted-foreground" />
        </button>

        <p className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Workspace</p>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const isActive = activeItem.path === item.path;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex w-full items-center gap-3 whitespace-nowrap rounded-md border-l-2 px-3 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? "border-primary bg-card font-semibold text-navy shadow-soft"
                    : "border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-navy"
                }`}
              >
                <span className={isActive ? 'text-primary' : undefined}>{item.icon}</span>
                <span className="min-w-0 flex-1">{item.label}</span>
                {item.path === '/patients' && (
                  <span className="ml-auto rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-bold text-primary">32</span>
                )}
              </Link>
            );
          })}
        </nav>

        <p className="mb-2 mt-8 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Manage</p>
        <button
          onClick={() => toast({ title: "Settings opened" })}
          className="flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2.5 text-left text-sm text-muted-foreground transition hover:bg-sidebar-accent hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings2 size={16} />Settings
        </button>

        <div className="mt-auto rounded-lg border border-border bg-card p-3 shadow-soft">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Data status</span>
            <span className="h-2 w-2 rounded-full bg-primary" />
          </div>
          <p className="mt-2 text-xs font-medium text-foreground">All systems reporting</p>
          <p className="mt-1 text-[10px] text-muted-foreground">Updated just now</p>
        </div>
      </aside>

      {/* Main Content Area */}
      <section className="min-w-0 flex-1 flex flex-col h-[100dvh]">
        <header className="flex shrink-0 h-[68px] items-center justify-between gap-2 border-b border-border bg-paper-alt px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">Operations</span>
            <span className="text-muted-foreground/40 hidden sm:inline">/</span>
            <strong className="truncate font-serif text-[15px] font-bold tracking-[.01em] text-navy">{activeItem.label}</strong>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DateRangeControl />
            {searchOpen && (
              <input
                autoFocus
                placeholder="Search patient or ID..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-9 w-32 rounded-md border border-border bg-card px-3 text-xs shadow-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring sm:w-48"
                onKeyDown={handleSearchSubmit}
              />
            )}
            <ActionButton label="Search" onClick={() => setSearchOpen(!searchOpen)}>
              <Search size={16} />
            </ActionButton>
            <ActionButton label="Notifications" onClick={() => toast({ title: "Notifications", description: "No new notifications." })}>
              <Bell size={16} />
            </ActionButton>

            <button
              onClick={() => toast({ title: "Account menu opened" })}
              className="ml-1 flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground shadow-xs">SJ</span>
              <span className="hidden text-left md:block">
                <b className="block text-xs font-semibold text-navy">Dr. Sarah Jenkins</b>
                <small className="text-[10px] text-muted-foreground">Medical Director</small>
              </span>
              <ChevronDown size={13} className="text-muted-foreground" />
            </button>
          </div>
        </header>

        {/* The scrollable content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-x-hidden overflow-y-auto">
          {children}
        </div>

        <nav aria-label="Mobile primary navigation" className="grid shrink-0 grid-cols-5 border-t border-border bg-paper-alt md:hidden">
          {navItems.map((item) => {
            const isActive = activeItem.path === item.path;
            const mobileLabel = item.path === '/analytics' ? 'Outcomes' : item.label;
            return (
              <Link
                key={item.path}
                href={item.path}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 border-t-2 px-1 py-2 text-center text-[9px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive
                    ? 'border-primary bg-accent text-navy'
                    : 'border-transparent text-muted-foreground hover:bg-secondary'
                }`}
              >
                <span className={isActive ? 'text-primary' : undefined}>{item.icon}</span>
                <span className="leading-tight">{mobileLabel}</span>
              </Link>
            );
          })}
        </nav>

        {/* Synthetic Data Disclaimer Footer */}
        <div className="shrink-0 border-t border-border bg-sidebar px-5 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
            Synthetic Demo Data • Not Medical Advice
          </p>
        </div>
      </section>
    </div>
  );
}
