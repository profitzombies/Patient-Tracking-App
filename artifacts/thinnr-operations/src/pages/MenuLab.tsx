/**
 * /menu — the side-menu design lab.
 *
 * Six candidate redesigns of the office rail render against a mock
 * workspace backdrop so they can be compared live, each with a Pinned /
 * Hover behavior toggle. Everything here is a preview: nav clicks re-point
 * the simulated active state, sign-out and settings only toast, and the live
 * app menu stays untouched until a winner is chosen.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, Bell, MousePointer2, Pin, Search } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useProviderScope } from '@/contexts/provider-scope';
import { useScopedPatients } from '@/data/scoped-data';
import {
  findActiveOfficeNavItem,
  OFFICE_NAV_ITEMS,
  useOfficeIdentity,
} from '@/components/layout/nav-config';
import { MENU_DESIGN_OPTIONS } from '@/components/menu-lab/options';
import type { RailMode } from '@/components/menu-lab/types';

export default function MenuLab() {
  const scope = useProviderScope();
  const { toast } = useToast();
  const patients = useScopedPatients();
  const identity = useOfficeIdentity();

  const [designId, setDesignId] = useState(MENU_DESIGN_OPTIONS[0].id);
  const [modes, setModes] = useState<Record<string, RailMode>>(() =>
    Object.fromEntries(MENU_DESIGN_OPTIONS.map((option) => [option.id, 'pinned' as RailMode])),
  );
  const [activePath, setActivePath] = useState('/');

  useEffect(() => {
    document.title = 'Menu lab — THINNR Med Spa Operations';
  }, []);

  const selected =
    MENU_DESIGN_OPTIONS.find((option) => option.id === designId) ?? MENU_DESIGN_OPTIONS[0];
  const mode = modes[selected.id] ?? 'pinned';
  const Design = selected.Component;

  return (
    <div className={`${scope ? 'h-full' : 'h-[100dvh]'} overflow-y-auto bg-background text-foreground`}>
      <div className="mx-auto flex min-h-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:px-6 lg:px-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">
              Design lab
            </p>
            <h1 className="mt-0.5 font-serif text-xl font-bold tracking-[.01em] text-navy">
              Side menu lab
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Six directions for the operations rail. Porcelain (6) is the one running in the
              live app; flip through the others to compare.
            </p>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            <div
              role="group"
              aria-label="Menu behavior"
              className="inline-flex items-center rounded-md border border-border bg-card p-0.5 shadow-xs"
            >
              {(['pinned', 'hover'] as const).map((behavior) => {
                const isOn = mode === behavior;
                const Icon = behavior === 'pinned' ? Pin : MousePointer2;
                return (
                  <button
                    key={behavior}
                    aria-pressed={isOn}
                    onClick={() => setModes((prev) => ({ ...prev, [selected.id]: behavior }))}
                    className={`inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isOn ? 'bg-navy text-white shadow-xs' : 'text-muted-foreground hover:text-navy'
                    }`}
                  >
                    <Icon size={12} />
                    {behavior === 'pinned' ? 'Pinned' : 'Hover'}
                  </button>
                );
              })}
            </div>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft size={13} />
              Back to the app
            </Link>
          </div>
        </header>

        <div className="hidden md:block">
          <div
            role="group"
            aria-label="Menu design options"
            className="flex flex-wrap items-center gap-1.5"
          >
            {MENU_DESIGN_OPTIONS.map((option, index) => (
              <button
                key={option.id}
                aria-pressed={option.id === selected.id}
                onClick={() => setDesignId(option.id)}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  option.id === selected.id
                    ? 'border-navy bg-navy text-white shadow-soft'
                    : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-navy'
                }`}
              >
                {index + 1} · {option.name}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-semibold text-navy">{selected.name}.</span> {selected.blurb}
            {mode === 'hover' && <span> Hover or Tab into the slim rail to expand it.</span>}
          </p>
        </div>

        {/* Full-height stage: candidate menu + mock workspace backdrop */}
        <div className="hidden min-h-[540px] flex-1 overflow-hidden rounded-lg border border-card-border bg-background shadow-soft md:flex">
          <Design
            key={selected.id}
            mode={mode}
            items={OFFICE_NAV_ITEMS}
            activePath={activePath}
            onSelect={setActivePath}
            onModeChange={(nextMode) => setModes((prev) => ({ ...prev, [selected.id]: nextMode }))}
            patientCount={patients.length}
            workspaceLabel={identity.workspaceLabel}
            accountName={identity.accountName}
            accountRole={identity.accountRole}
            accountInitials={identity.initials}
            onSettings={() =>
              toast({
                title: 'Settings (preview)',
                description: 'In the live menu this opens settings; the lab only previews the item.',
              })
            }
            onSignOut={() =>
              toast({
                title: 'Sign out (preview)',
                description: 'In the live menu this signs you out; the lab only previews the control.',
              })
            }
          />
          <MockContent activeLabel={findActiveOfficeNavItem(activePath).label} initials={identity.initials} />
        </div>

        {/* Phone fallback — the lab is desktop-first */}
        <div className="md:hidden">
          <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
            <h2 className="font-serif text-base font-bold tracking-[.01em] text-navy">
              Built for desktop
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              The menu lab compares hover-retract behavior side by side, which needs a pointer and
              a wide screen. Open /menu on a computer to flip through the six live previews.
            </p>
            <ol className="mt-4 space-y-3">
              {MENU_DESIGN_OPTIONS.map((option, index) => (
                <li key={option.id} className="text-xs leading-relaxed text-muted-foreground">
                  <b className="font-semibold text-navy">
                    {index + 1} · {option.name}
                  </b>{' '}
                  — {option.blurb}
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Decorative stand-in for the workspace so each menu is judged in context. */
function MockContent({ activeLabel, initials }: { activeLabel: string; initials: string }) {
  const stats = [
    { label: 'Active patients', value: '128', delta: '+12 this period' },
    { label: 'Recurring revenue', value: '$84.2k', delta: '+6.4%' },
    { label: 'Avg weight change', value: '−9.8%', delta: 'On plan' },
  ];
  const rows: Array<[string, string, string]> = [
    ['Marisol Vega', '−2.1 lb', 'Check-in logged'],
    ['Devon Price', '−1.4 lb', 'Photos updated'],
    ['June Okafor', '−0.8 lb', 'Coach replied'],
    ['Priya Natarajan', '−1.9 lb', 'Delivery confirmed'],
  ];
  const bars = [46, 62, 38, 74, 58, 82, 50, 88, 64, 92, 70, 96];

  return (
    <div aria-hidden className="pointer-events-none flex min-w-0 flex-1 select-none flex-col bg-background">
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-border bg-paper-alt px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-xs text-muted-foreground">Operations</span>
          <span className="text-muted-foreground/40">/</span>
          <strong className="truncate font-serif text-[15px] font-bold tracking-[.01em] text-navy">
            {activeLabel}
          </strong>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-xs lg:inline">
            Jan 5 – Feb 3
          </span>
          <span className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card text-primary shadow-xs">
            <Search size={16} />
          </span>
          <span className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card text-primary shadow-xs">
            <Bell size={16} />
          </span>
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground shadow-xs">
            {initials}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-6">
        <div className="grid shrink-0 grid-cols-3 gap-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg border border-card-border bg-card p-4 shadow-soft">
              <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                {stat.label}
              </p>
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-serif text-2xl font-bold text-navy">{stat.value}</span>
                <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-bold text-primary">
                  {stat.delta}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[1.6fr_1fr] gap-4">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
            <div className="border-b border-border px-5 py-4">
              <h2 className="font-serif text-base font-bold tracking-[.01em] text-navy">
                Weight outcomes
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Average change across active plans</p>
            </div>
            <div className="min-h-0 flex-1 p-5">
              <div className="flex h-full items-end gap-1.5">
                {bars.map((height, index) => (
                  <div
                    key={index}
                    style={{ height: `${height}%` }}
                    className={`w-full rounded-t-sm ${index % 3 === 2 ? 'bg-[#315eae]' : 'bg-[#c9d4e8]'}`}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
            <div className="border-b border-border px-5 py-4">
              <h2 className="font-serif text-base font-bold tracking-[.01em] text-navy">
                Recent check-ins
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Latest synthetic activity</p>
            </div>
            <ul className="min-h-0 flex-1 overflow-hidden">
              {rows.map(([name, delta, note]) => (
                <li
                  key={name}
                  className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
                >
                  <span className="min-w-0">
                    <b className="block truncate text-xs font-semibold text-foreground">{name}</b>
                    <small className="block truncate text-[10px] text-muted-foreground">{note}</small>
                  </span>
                  <span className="shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-bold text-primary">
                    {delta}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
