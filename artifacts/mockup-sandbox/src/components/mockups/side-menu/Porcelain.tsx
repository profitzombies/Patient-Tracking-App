import { useMemo, useState } from 'react';
import {
  Box,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  MousePointer2,
  Pin,
  Plus,
  Trophy,
  Users,
  WalletCards,
} from 'lucide-react';

/**
 * Design 6 — "Porcelain": the white console menu from the user's reference.
 * White sidebar, bordered workspace card up top, ink CTA button, tiny
 * uppercase section labels, cobalt-filled active row, account chip and a
 * Pinned/Hover pill at the very bottom. Heritage-adapted: soft 9/7px radii,
 * cobalt #315eae, navy #203b64, Playfair for the brand wordmark.
 */

const COBALT = '#315eae';
const NAVY = '#203b64';
const INK = '#101828';
const HAIRLINE = '#dbe2ea';
const PAPER = '#f2f3f4';
const CREAM = '#fdfcf9';
const MUTED = '#5c6b81';
const LABEL = '#8593a7';

type Mode = 'pinned' | 'hover';

type NavItem = { id: string; label: string; icon: typeof Users };
type NavSection = { label: string; items: NavItem[] };

const SECTIONS: NavSection[] = [
  { label: 'Dashboard', items: [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }] },
  {
    label: 'Operations',
    items: [
      { id: 'patients', label: 'Patients', icon: Users },
      { id: 'subscriptions', label: 'Subscriptions', icon: Box },
    ],
  },
  {
    label: 'Insights',
    items: [
      { id: 'analytics', label: 'Revenue & Outcomes', icon: WalletCards },
      { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
    ],
  },
  { label: 'Learning', items: [{ id: 'training', label: 'Training', icon: GraduationCap }] },
];

const RAIL_W = 68;
const FULL_W = 264;

function BrandTile() {
  return (
    <div
      className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] text-white"
      style={{ background: NAVY, fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 15 }}
    >
      TH
    </div>
  );
}

function PorcelainSideMenu({
  mode,
  onModeChange,
  active,
  onSelect,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  active: string;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const expanded = mode === 'pinned' || hovered;

  return (
    <div className="relative h-full shrink-0 transition-[width] duration-200" style={{ width: mode === 'pinned' ? FULL_W : RAIL_W }}>
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setHovered(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
        }}
        className="absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden bg-white transition-[width] duration-200 ease-out"
        style={{
          width: expanded ? FULL_W : RAIL_W,
          borderRight: `1px solid ${HAIRLINE}`,
          boxShadow: mode === 'hover' && expanded ? '0 2px 4px rgba(32,59,100,0.06), 0 18px 44px -22px rgba(32,59,100,0.4)' : 'none',
        }}
      >
        {/* Workspace card */}
        <div className="px-3 pt-3">
          <div
            className="flex items-center gap-2.5 rounded-[9px] bg-white p-2"
            style={{ border: `1px solid ${HAIRLINE}` }}
          >
            <BrandTile />
            {expanded && (
              <div className="min-w-0">
                <div
                  className="truncate text-[14px] leading-tight"
                  style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, color: NAVY }}
                >
                  THINNR Operations
                </div>
                <div className="truncate text-[11px]" style={{ color: MUTED }}>
                  Jenkins Aesthetics &amp; Wellness
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Ink CTA */}
        <div className="px-3 pt-2.5">
          <button
            className={`flex h-9 items-center rounded-[7px] text-[13px] font-medium text-white transition hover:opacity-90 ${
              expanded ? 'w-full justify-center gap-1.5 px-3' : 'w-full justify-center'
            }`}
            style={{ background: INK }}
          >
            <Plus size={15} strokeWidth={2.5} />
            {expanded && <span>Add patient</span>}
          </button>
        </div>

        {/* Sections */}
        <nav className="mt-3 flex-1 overflow-y-auto px-3 pb-2">
          {SECTIONS.map((section, i) => (
            <div key={section.label} className={i === 0 ? '' : 'mt-4'}>
              {expanded ? (
                <div
                  className="px-2 pb-1.5 text-[10px] font-semibold uppercase"
                  style={{ color: LABEL, letterSpacing: '0.09em' }}
                >
                  {section.label}
                </div>
              ) : (
                i !== 0 && <div className="mx-2 mb-2 border-t" style={{ borderColor: HAIRLINE }} />
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.id === active;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onSelect(item.id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex h-9 w-full items-center rounded-[7px] text-[13px] transition-colors ${
                        expanded ? 'gap-2.5 px-2.5' : 'justify-center'
                      }`}
                      style={
                        isActive
                          ? { background: COBALT, color: '#ffffff', fontWeight: 500 }
                          : { color: MUTED }
                      }
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = '#f0f3f8';
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <Icon size={16} strokeWidth={isActive ? 2.2 : 1.9} className="shrink-0" />
                      {expanded && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Foot: account chip + pinned/hover pill */}
        <div className="mt-auto px-3 pb-3 pt-2" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
          <div className={`flex items-center ${expanded ? 'gap-2.5' : 'justify-center'} rounded-[7px] p-1.5`}>
            <div
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
              style={{ background: '#e8eef7', color: COBALT }}
            >
              DR
            </div>
            {expanded && (
              <>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium" style={{ color: '#26364b' }}>
                    Dana Rodriguez
                  </div>
                  <div className="truncate text-[11px]" style={{ color: MUTED }}>
                    Front desk
                  </div>
                </div>
                <button
                  aria-label="Sign out"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] transition hover:bg-[#f0f3f8]"
                  style={{ color: MUTED }}
                >
                  <LogOut size={14} />
                </button>
              </>
            )}
          </div>
          <button
            onClick={() => onModeChange(mode === 'pinned' ? 'hover' : 'pinned')}
            className={`mt-1.5 flex h-8 items-center rounded-[7px] bg-white text-[12px] font-medium transition hover:bg-[#f7f9fc] ${
              expanded ? 'w-full justify-center gap-1.5 px-3' : 'w-full justify-center'
            }`}
            style={{ border: `1px solid ${HAIRLINE}`, color: '#43536b' }}
            title={mode === 'pinned' ? 'Switch to hover mode (menu collapses to a rail)' : 'Switch to pinned mode (menu stays open)'}
          >
            {mode === 'pinned' ? <Pin size={13} /> : <MousePointer2 size={13} />}
            {expanded && <span>{mode === 'pinned' ? 'Pinned' : 'Hover'}</span>}
          </button>
        </div>
      </aside>
    </div>
  );
}

function DemoContent({ title }: { title: string }) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[880px] px-8 py-7">
        <div className="text-[11px] font-semibold uppercase" style={{ color: LABEL, letterSpacing: '0.09em' }}>
          Jenkins Aesthetics &amp; Wellness
        </div>
        <h1
          className="mt-1 text-[26px]"
          style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, color: NAVY }}
        >
          {title}
        </h1>
        <div className="mt-5 grid grid-cols-3 gap-4">
          {[
            ['Active patients', '128'],
            ['Avg. weekly change', '-1.4 lb'],
            ['Check-ins today', '23'],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-[9px] p-4"
              style={{ background: CREAM, border: `1px solid ${HAIRLINE}`, boxShadow: '0 1px 2px rgba(32,59,100,0.05), 0 10px 28px -20px rgba(32,59,100,0.28)' }}
            >
              <div className="text-[11px] font-semibold uppercase" style={{ color: LABEL, letterSpacing: '0.08em' }}>
                {label}
              </div>
              <div className="mt-1.5 text-[22px] font-semibold" style={{ color: '#26364b' }}>
                {value}
              </div>
            </div>
          ))}
        </div>
        <div
          className="mt-4 h-56 rounded-[9px]"
          style={{ background: CREAM, border: `1px solid ${HAIRLINE}`, boxShadow: '0 1px 2px rgba(32,59,100,0.05), 0 10px 28px -20px rgba(32,59,100,0.28)' }}
        />
        <p className="mt-4 text-[12px]" style={{ color: MUTED }}>
          Preview stage — use the pill at the bottom of the menu to flip between Pinned and Hover. In Hover mode the
          menu rests as a slim rail and glides open when you mouse over it.
        </p>
      </div>
    </main>
  );
}

export function Porcelain() {
  const initialMode: Mode = useMemo(() => {
    if (typeof window === 'undefined') return 'pinned';
    return new URLSearchParams(window.location.search).get('mode') === 'hover' ? 'hover' : 'pinned';
  }, []);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [active, setActive] = useState('overview');
  const activeLabel =
    SECTIONS.flatMap((s) => s.items).find((i) => i.id === active)?.label ?? 'Overview';

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: PAPER, fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}
    >
      <PorcelainSideMenu mode={mode} onModeChange={setMode} active={active} onSelect={setActive} />
      <DemoContent title={activeLabel} />
    </div>
  );
}
