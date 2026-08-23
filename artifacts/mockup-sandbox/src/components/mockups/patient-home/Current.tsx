/**
 * Current (baseline) — faithful web port of the live THINNR patient home
 * (artifacts/thinnr-mobile/app/(patient)/today.tsx), Cobalt Ledger skin.
 * Static mockup: real demo data for Emma Smith on 2026-08-22, no routing.
 */
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  CircleCheck,
  Clipboard,
  Droplet,
  LayoutGrid,
  MessageCircle,
  Minus,
  Plus,
  Sun,
  TrendingDown,
  Utensils,
} from 'lucide-react';

// ─── Cobalt Ledger tokens (constants/colors.ts) ──────────────────────────────
const C = {
  background: '#eef1f6',
  card: '#fbfcff',
  border: '#bdc9dc',
  divider: '#dfe5ef',
  sidebarBg: '#e3e8f1',
  navy: '#172c56',
  navyLight: '#284675',
  cobalt: '#315fc0',
  cobaltLight: '#5576c2',
  cobaltMuted: '#8da4d6',
  labelText: '#74839d',
  bodyText: '#53698f',
  subtleText: '#8793a8',
  paperCardAlt: '#f8f9fc',
  primaryForeground: '#fbfcff',
  accent: '#e3e8f1',
  inactiveTab: '#8793a8',
};

const inter = 'Inter, system-ui, sans-serif';
const playfair = '"Playfair Display", Georgia, serif';
const HALO = { textShadow: '0 0 10px rgba(240,244,250,0.9)' } as const;

const HERO_TOP_PAD = 67; // web fake-chrome reserve
const HERO_HEIGHT = HERO_TOP_PAD + 296;
const PILL_OVERLAP = 22;

// ─── Small primitives ─────────────────────────────────────────────────────────
function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: inter, fontWeight: 700, fontSize: 10, letterSpacing: 1.4, color: C.labelText }}>
      {children}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ marginTop: 4, marginBottom: 8 }}>
      <CardLabel>{label.toUpperCase()}</CardLabel>
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ backgroundColor: C.card, border: `1px solid ${C.border}`, ...style }}>{children}</div>
  );
}

function ProgressBar({ value, color, height = 8, style }: { value: number; color?: string; height?: number; style?: React.CSSProperties }) {
  const clipped = Math.min(100, Math.max(0, value));
  return (
    <div style={{ height, backgroundColor: C.accent, overflow: 'hidden', ...style }}>
      <div style={{ height: '100%', width: `${clipped}%`, backgroundColor: color ?? C.cobalt }} />
    </div>
  );
}

function MacroRow({ label, value, target, color }: { label: string; value: number; target: number; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 9, letterSpacing: 1.2, color: C.labelText }}>
          {label.toUpperCase()}
        </span>
        <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 11, color: C.navyLight }}>
          {value}
          <span style={{ color: C.subtleText }}> / {target} g</span>
        </span>
      </div>
      <ProgressBar value={(value / target) * 100} color={color} height={6} />
    </div>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function Current() {
  const meals = [
    { name: 'Breakfast', meta: '2 items · 322 cal' },
    { name: 'Lunch', meta: '1 item · 420 cal' },
    { name: 'Dinner', meta: 'Nothing logged yet' },
    { name: 'Snacks', meta: '1 item · 190 cal' },
  ];
  const tabs = [
    { label: 'Today', Icon: Sun, active: true },
    { label: 'Diary', Icon: BookOpen, active: false },
    { label: 'Library', Icon: LayoutGrid, active: false },
    { label: 'Progress', Icon: TrendingDown, active: false },
    { label: 'Plan', Icon: Clipboard, active: false },
  ];

  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative', backgroundColor: C.background, overflow: 'hidden', fontFamily: inter }}>
      <div style={{ height: '100%', overflowY: 'auto' }}>
        <div style={{ paddingBottom: 84 + 20 }}>
          {/* ── Illustrated hero ── */}
          <div style={{ position: 'relative', height: HERO_HEIGHT + PILL_OVERLAP }}>
            <img
              src="/__mockup/images/home-hero.jpg"
              alt=""
              style={{ position: 'absolute', top: 0, left: 0, right: 0, width: '100%', height: HERO_HEIGHT, objectFit: 'cover', objectPosition: 'top center' }}
            />
            <div
              style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: HERO_TOP_PAD + 205, pointerEvents: 'none',
                background: 'linear-gradient(to bottom, rgba(237,242,249,0.96) 0%, rgba(237,242,249,0.74) 45%, rgba(237,242,249,0.32) 75%, rgba(237,242,249,0) 100%)',
              }}
            />
            <div
              style={{
                position: 'absolute', left: 0, right: 0, bottom: PILL_OVERLAP, height: 56, pointerEvents: 'none',
                background: 'linear-gradient(to bottom, rgba(238,241,246,0) 0%, rgba(238,241,246,0.45) 100%)',
              }}
            />

            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: HERO_TOP_PAD + 8, paddingLeft: 16, paddingRight: 16 }}>
              {/* Top row: wordmark + actions */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontFamily: playfair, fontWeight: 700, fontSize: 25, letterSpacing: 2.5, color: C.navy, ...HALO }}>THINNR</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, border: `1px solid ${C.border}`, backgroundColor: C.card, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <MessageCircle size={16} color={C.cobalt} />
                  </div>
                  <div style={{ width: 30, height: 30, backgroundColor: C.cobalt, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 10, color: C.primaryForeground }}>ES</span>
                  </div>
                </div>
              </div>

              {/* Date pager */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ArrowLeft size={18} color={C.navy} />
                </div>
                <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 13, letterSpacing: 0.2, color: C.navy, ...HALO }}>
                  Saturday, August 22, 2026
                </span>
                <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3 }}>
                  <ArrowRight size={18} color={C.navy} />
                </div>
              </div>

              {/* Greeting */}
              <div style={{ fontFamily: playfair, fontWeight: 600, fontSize: 25, letterSpacing: -0.2, marginTop: 8, color: C.navy, ...HALO }}>
                Welcome back, Emma
              </div>

              {/* Quick-link chips */}
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                {[
                  { Icon: Utensils, label: 'Restaurant guide' },
                  { Icon: CircleCheck, label: 'Approved list' },
                ].map(({ Icon, label }) => (
                  <div
                    key={label}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', gap: 7, borderRadius: 12,
                      border: '1px solid rgba(23,44,86,0.14)', backgroundColor: 'rgba(251,252,255,0.95)',
                      padding: '10px 11px', boxShadow: '0 4px 10px rgba(23,44,86,0.16)',
                    }}
                  >
                    <Icon size={14} color={C.navy} />
                    <span style={{ flex: 1, fontFamily: inter, fontWeight: 600, fontSize: 12.5, color: C.navyLight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {label}
                    </span>
                    <ChevronRight size={13} color={C.subtleText} />
                  </div>
                ))}
              </div>
            </div>

            {/* Floating check-in pill */}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center' }}>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, maxWidth: '86%', borderRadius: 999,
                  border: '1px solid rgba(251,252,255,0.3)', backgroundColor: 'rgba(23,44,86,0.86)',
                  padding: '9px 12px', boxShadow: '0 6px 14px rgba(23,44,86,0.22)',
                }}
              >
                <div style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(251,252,255,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <MessageCircle size={13} color="#fbfcff" />
                </div>
                <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 13, color: '#fbfcff' }}>Getting enough sleep?</span>
                <ChevronRight size={14} color="rgba(251,252,255,0.8)" />
              </div>
            </div>
          </div>

          {/* ── Body ── */}
          <div style={{ padding: '16px 16px 0' }}>
            {/* Program instructions */}
            <Card style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 34, height: 34, backgroundColor: C.sidebarBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <BookOpen size={15} color={C.cobalt} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <CardLabel>PROGRAM INSTRUCTIONS</CardLabel>
                  <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 13.5, marginTop: 3, color: C.navyLight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Day 94 · Metabolic Normalization Phase
                  </div>
                </div>
                <ChevronRight size={16} color={C.subtleText} />
              </div>
            </Card>

            {/* Calories */}
            <Card style={{ padding: 16, marginBottom: 14 }}>
              <CardLabel>CALORIES REMAINING</CardLabel>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 10 }}>
                <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 40, letterSpacing: -2, lineHeight: 1, color: C.navy }}>568</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 8 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 15, color: C.navyLight }}>1,500</span>
                    <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 8, letterSpacing: 1, marginTop: 2, color: C.labelText }}>GOAL</span>
                  </div>
                  <span style={{ fontFamily: inter, fontSize: 16, color: C.subtleText }}>−</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 15, color: C.navyLight }}>932</span>
                    <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 8, letterSpacing: 1, marginTop: 2, color: C.labelText }}>FOOD</span>
                  </div>
                </div>
              </div>
              <ProgressBar value={(932 / 1500) * 100} style={{ marginTop: 12 }} />
              <div style={{ fontFamily: inter, fontSize: 11, marginTop: 8, color: C.subtleText }}>568 cal left for dinner and snacks</div>
            </Card>

            {/* Macros */}
            <Card style={{ padding: 16, marginBottom: 14 }}>
              <CardLabel>MACROS</CardLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                <MacroRow label="Protein" value={73} target={120} color={C.cobalt} />
                <MacroRow label="Carbs" value={70} target={130} color={C.cobaltLight} />
                <MacroRow label="Fat" value={43} target={50} color={C.cobaltMuted} />
              </div>
            </Card>

            {/* Meals */}
            <SectionHeader label="Meals" />
            <Card style={{ marginBottom: 14 }}>
              {meals.map((meal, i) => (
                <div key={meal.name}>
                  {i > 0 && <div style={{ height: 1, backgroundColor: C.divider }} />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 13, color: C.navyLight }}>{meal.name}</div>
                      <div style={{ fontFamily: inter, fontSize: 11, marginTop: 2, color: C.subtleText }}>{meal.meta}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1px solid ${C.border}`, backgroundColor: C.card, padding: '6px 10px' }}>
                      <Plus size={13} color={C.cobalt} />
                      <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 11, color: C.cobalt }}>Add</span>
                    </div>
                  </div>
                </div>
              ))}
            </Card>

            {/* Water */}
            <SectionHeader label="Water" />
            <Card style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Array.from({ length: 8 }).map((_, i) => {
                  const filled = i < 4;
                  return (
                    <div
                      key={i}
                      style={{
                        width: 34, height: 34, border: `1px solid ${filled ? C.cobalt : C.border}`,
                        backgroundColor: filled ? C.cobalt : C.paperCardAlt,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <Droplet size={14} color={filled ? C.primaryForeground : C.cobaltMuted} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 12, color: C.navyLight }}>
                  32<span style={{ color: C.subtleText }}> of 64 fl oz</span>
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ width: 28, height: 28, border: `1px solid ${C.border}`, backgroundColor: C.card, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Minus size={14} color={C.bodyText} />
                  </div>
                  <div style={{ width: 28, height: 28, border: `1px solid ${C.border}`, backgroundColor: C.card, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Plus size={14} color={C.bodyText} />
                  </div>
                </div>
              </div>
            </Card>

            {/* Daily check-in */}
            <SectionHeader label="Daily Check-In" />
            <Card style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 13, color: C.navyLight }}>You haven't checked in today</div>
              <div style={{ fontFamily: inter, fontSize: 11, marginTop: 3, color: C.subtleText }}>
                Log your weight, mood, and how the plan feels. It takes 30 seconds.
              </div>
              <div style={{ marginTop: 14, padding: '12px 0', backgroundColor: C.cobalt, display: 'flex', justifyContent: 'center' }}>
                <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 13, letterSpacing: 0.3, color: C.primaryForeground }}>Complete Check-In</span>
              </div>
            </Card>

            {/* Weight snapshot */}
            <SectionHeader label="Weight" />
            <Card style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex' }}>
                {[
                  { value: '167.2', label: 'CURRENT LBS', color: C.navy },
                  { value: '−12.8', label: 'SINCE START', color: C.cobalt },
                  { value: '150', label: 'GOAL LBS', color: C.navyLight },
                ].map(col => (
                  <div key={col.label} style={{ flex: 1 }}>
                    <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 22, letterSpacing: -0.8, color: col.color }}>{col.value}</div>
                    <div style={{ fontFamily: inter, fontWeight: 700, fontSize: 8, letterSpacing: 1, marginTop: 3, color: C.labelText }}>{col.label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14 }}>
                <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 12, color: C.cobalt }}>View full progress</span>
                <ArrowRight size={13} color={C.cobalt} />
              </div>
            </Card>

            {/* Synthetic disclaimer */}
            <div style={{ borderTop: `1px solid ${C.divider}`, backgroundColor: C.sidebarBg, padding: '10px 0', display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
              <span style={{ fontFamily: inter, fontWeight: 700, fontSize: 9, letterSpacing: 1.2, color: C.labelText }}>
                SYNTHETIC DEMO DATA&ensp;•&ensp;NOT MEDICAL ADVICE
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tab bar (web height 84, border-top, paper bg) ── */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, height: 84,
          borderTop: `1px solid ${C.border}`, backgroundColor: C.background,
          display: 'flex', alignItems: 'flex-start', paddingTop: 10,
        }}
      >
        {tabs.map(({ label, Icon, active }) => (
          <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <Icon size={22} color={active ? C.cobalt : C.inactiveTab} strokeWidth={active ? 2.2 : 2} />
            <span style={{ fontFamily: inter, fontWeight: active ? 600 : 400, fontSize: 10, color: active ? C.cobalt : C.inactiveTab }}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
