import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Box,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Filter,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserCog,
  Users,
  WalletCards,
  X,
  type LucideIcon,
} from 'lucide-react';
import './_fl-base.css';
import './FloatingLabelsDashboard.css';

/*
 * THINNR Operations — the real Overview page (Shell + Overview.tsx) restyled
 * in the Floating Labels language. Every section below exists in the live
 * app: Practice Pulse header, four metrics, overdue banner, Revenue Trend,
 * Protocol Stages, Priority items, Companion-app logging, Patient watchlist,
 * Team movement. Demo numbers come from the app's own mock analytics.
 */

const NAV_SECTIONS: { label: string; items: { label: string; icon: LucideIcon }[] }[] = [
  { label: 'Dashboard', items: [{ label: 'Overview', icon: LayoutDashboard }] },
  { label: 'Operations', items: [{ label: 'Patients', icon: Users }, { label: 'Subscriptions', icon: Box }] },
  { label: 'Insights', items: [{ label: 'Revenue & Outcomes', icon: WalletCards }, { label: 'Leaderboard', icon: Trophy }] },
  { label: 'Learning', items: [{ label: 'Training', icon: GraduationCap }, { label: 'AI Support', icon: Sparkles }] },
  { label: 'Administration', items: [{ label: 'Team', icon: UserCog }, { label: 'Audit trail', icon: ClipboardList }, { label: 'Security', icon: ShieldCheck }] },
];

type ProviderId = 'all' | 'p1' | 'p2' | 'p3' | 'p4';
const PROVIDERS: { id: ProviderId; name: string; short: string; active: number; mrr: number; avgLost: number; overdue: number }[] = [
  { id: 'all', name: 'All Providers', short: 'All providers', active: 632, mrr: 122200, avgLost: 24.5, overdue: 4 },
  { id: 'p1', name: 'Dr. Sarah Jenkins', short: 'Sarah Jenkins', active: 142, mrr: 27400, avgLost: 26.1, overdue: 1 },
  { id: 'p2', name: 'Michael Chen, NP', short: 'Michael Chen', active: 185, mrr: 35700, avgLost: 24.9, overdue: 1 },
  { id: 'p3', name: 'Elena Rostova, RN', short: 'Elena Rostova', active: 210, mrr: 40600, avgLost: 23.2, overdue: 2 },
  { id: 'p4', name: 'David Kim, NP', short: 'David Kim', active: 95, mrr: 18300, avgLost: 22.7, overdue: 0 },
];

type Status = 'graduated' | 'active' | 'overdue' | 'paused';
const WATCHLIST: { id: string; name: string; providerId: ProviderId; stage: string; status: Status; lost: number }[] = [
  { id: 'pat_100', name: 'Emma Smith', providerId: 'p1', stage: 'Maintenance', status: 'graduated', lost: 27.4 },
  { id: 'pat_101', name: 'Liam Brown', providerId: 'p2', stage: 'Wk 3', status: 'active', lost: 8.2 },
  { id: 'pat_102', name: 'Olivia Miller', providerId: 'p3', stage: 'Wk 5', status: 'overdue', lost: 11.6 },
  { id: 'pat_103', name: 'Noah Martinez', providerId: 'p4', stage: 'Wk 2', status: 'paused', lost: 4.9 },
  { id: 'pat_104', name: 'Ava Gonzalez', providerId: 'p1', stage: 'Wk 4', status: 'active', lost: 10.3 },
];

const LAPSED = [
  { id: 'pat_103', initials: 'NM', name: 'Noah Martinez', days: 6 },
  { id: 'pat_106', initials: 'SJ', name: 'Sophia Jackson', days: 4 },
  { id: 'pat_107', initials: 'JP', name: 'James Perez', days: 3 },
];

const ACTIVITY: { initials: string; name: string; action: string; time: string; tone: 'aqua' | 'powder' | 'ink' }[] = [
  { initials: 'ER', name: 'Elena Rostova', action: 'completed week 4 check-in for Emma S.', time: '12 min ago', tone: 'aqua' },
  { initials: 'MC', name: 'Michael Chen', action: 'flagged overdue check-in for Liam J.', time: '46 min ago', tone: 'powder' },
  { initials: 'SJ', name: 'Sarah Jenkins', action: 'approved Maintenance Stack for Olivia W.', time: '2 hr ago', tone: 'ink' },
];

const STAGES: { name: string; count: number; tone: string }[] = [
  { name: 'Maintenance', count: 412, tone: 'ink' },
  { name: 'Protocol Weeks 1-3', count: 125, tone: 'teal' },
  { name: 'Protocol Weeks 4-6', count: 95, tone: 'aqua' },
];

const RANGES = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
];

// Demo anchor day: Wed, Aug 12 2026 (the app's synthetic "today").
const ANCHOR = Date.UTC(2026, 7, 12);
const DAY_MS = 86_400_000;

function dayLabel(daysAgo: number) {
  return new Date(ANCHOR - daysAgo * DAY_MS).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function revenueOf(daysAgo: number) {
  const seed = Math.abs(Math.sin((daysAgo + 1) * 12.9898) * 43758.5453) % 1;
  const weekday = (((3 - daysAgo) % 7) + 7) % 7; // 0 = Sunday
  const base = weekday === 0 || weekday === 6 ? 2600 : 4100;
  return Math.round(base + seed * 1900);
}
function niceCeil(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}
function money(value: number) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}
function buildRevenue(days: number) {
  const bucketSize = Math.ceil(days / 12);
  const buckets: { label: string; total: number }[] = [];
  for (let start = days - 1; start >= 0; start -= bucketSize) {
    let total = 0;
    for (let d = start; d > start - bucketSize && d >= 0; d--) total += revenueOf(d);
    buckets.push({ label: dayLabel(start), total });
  }
  const total = buckets.reduce((sum, b) => sum + b.total, 0);
  let previous = 0;
  for (let d = days; d < days * 2; d++) previous += revenueOf(d);
  const deltaPct = ((total - previous) / previous) * 100;
  return { buckets, total, deltaPct, axisMax: niceCeil(Math.max(...buckets.map((b) => b.total))) };
}

const STATUS_TONE: Record<Status, string> = { graduated: 'healthy', active: 'healthy', paused: 'watch', overdue: 'risk' };

export function FloatingLabelsDashboard() {
  const [active, setActive] = useState('Overview');
  const [rangeIndex, setRangeIndex] = useState(1);
  const [providerFilter, setProviderFilter] = useState<ProviderId>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [notice, setNotice] = useState(true);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  const range = RANGES[rangeIndex];
  const revenue = useMemo(() => buildRevenue(range.days), [range.days]);
  const provider = PROVIDERS.find((p) => p.id === providerFilter) ?? PROVIDERS[0];
  const watchlist = providerFilter === 'all' ? WATCHLIST : WATCHLIST.filter((p) => p.providerId === providerFilter);
  const overdue = provider.overdue;
  const totalStages = STAGES.reduce((sum, s) => sum + s.count, 0);

  const priority: { title: string; body: string; level: string; tone: string }[] = [
    { title: 'Failed Subscription Payments', body: '2 recurring payments failed this week', level: 'High', tone: 'risk' },
    { title: 'Missed Check-ins', body: `${overdue} patient${overdue === 1 ? '' : 's'} missed their scheduled protocol check-in`, level: 'Watch', tone: 'watch' },
    { title: 'High Adherence Cohort', body: '24 patients reached goal weight this week', level: 'Positive', tone: 'healthy' },
  ];

  const pickProvider = (id: ProviderId, name: string) => {
    setProviderFilter(id);
    setFilterOpen(false);
    setToast(`Filtered by ${name}`);
  };

  return (
    <main className="fld">
      <aside className="fld-side">
        <div className="fld-brand">
          <img className="fld-logo" src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" />
          <span className="fld-ws"><i className="fld-dot" />operations desk</span>
        </div>
        <nav className="fld-nav" aria-label="Office navigation">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="fld-nav-group">
              <p>{section.label}</p>
              {section.items.map(({ label, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  className={active === label ? 'on' : ''}
                  aria-current={active === label ? 'page' : undefined}
                  onClick={() => {
                    setActive(label);
                    if (label !== 'Overview') setToast(`Opening ${label}`);
                  }}
                >
                  <Icon size={14} strokeWidth={1.9} />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="fld-account">
          <span className="fld-avatar">SJ</span>
          <span className="fld-account-text">
            <b>Dr. Sarah Jenkins</b>
            <small>Medical Director</small>
          </span>
          <button type="button" className="fld-icon-btn" aria-label="Sign out" onClick={() => setToast('Signing out of the operations desk')}>
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      <div className="fld-stage">
        <header className="fld-bar">
          <h2 className="fld-bar-title"><i className="fld-cross" />{active}</h2>
          <div className="fld-bar-right">
            <div className="fld-range" role="group" aria-label="Date range">
              <button type="button" aria-label="Earlier range" onClick={() => setRangeIndex((i) => (i + RANGES.length - 1) % RANGES.length)}>
                <ChevronLeft size={13} />
              </button>
              <span><CalendarRange size={12} />{range.label}</span>
              <button type="button" aria-label="Later range" onClick={() => setRangeIndex((i) => (i + 1) % RANGES.length)}>
                <ChevronRight size={13} />
              </button>
            </div>
            <button type="button" className="fld-icon-btn" aria-label="Office settings" onClick={() => setToast('Opening office settings')}>
              <Settings size={15} />
            </button>
            <button type="button" className="fld-icon-btn" aria-label="Sign out" onClick={() => setToast('Signing out of the operations desk')}>
              <LogOut size={15} />
            </button>
          </div>
        </header>

        <div className="fld-scroll">
          <div className="fld-hero">
            <div>
              <p className="fld-eyebrow"><Activity size={12} /> Practice Pulse <i className="fld-sep" /> Aug 12, 2026</p>
              <h1>Good morning,<br />Dr. Jenkins.</h1>
              <p className="fld-lede">Here&rsquo;s what changed since your last login.</p>
            </div>

            <span className="fld-chip one"><i />{overdue} check-ins overdue</span>
            <span className="fld-chip ink two"><i />2 failed payments</span>
            <span className="fld-chip powder three"><i />84 new this month</span>

            <div className="fld-filter">
              {providerFilter !== 'all' && <span className="fld-filter-badge">{provider.name}</span>}
              <button
                type="button"
                className={`fld-icon-btn big${filterOpen ? ' open' : ''}`}
                aria-label="Filter dashboard"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen(!filterOpen)}
              >
                <Filter size={15} />
              </button>
              {filterOpen && (
                <div className="fld-menu" role="menu">
                  <p>View filter</p>
                  {PROVIDERS.map((p) => (
                    <button key={p.id} type="button" role="menuitem" className={providerFilter === p.id ? 'on' : ''} onClick={() => pickProvider(p.id, p.name)}>
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <section className="fld-strip" aria-label="Top metrics">
            <div className="fld-stat">
              <div className="fld-stat-row"><span className="fld-stat-label"><WalletCards size={12} />MRR</span><span className="fld-tag">Demo projection</span></div>
              <p className="fld-stat-value">{providerFilter === 'all' ? '$122.2k' : `$${provider.mrr.toLocaleString('en-US')}`}</p>
              <p className="fld-stat-detail">Synthetic finance · not live</p>
            </div>
            <div className="fld-stat">
              <div className="fld-stat-row"><span className="fld-stat-label"><Users size={12} />Active Patients</span><span className="fld-tag">+8.7%</span></div>
              <p className="fld-stat-value">{provider.active}</p>
              <p className="fld-stat-detail">84 new this month</p>
            </div>
            <div className="fld-stat">
              <div className="fld-stat-row"><span className="fld-stat-label"><Activity size={12} />Avg Pounds Lost</span><span className="fld-tag">+3.2%</span></div>
              <p className="fld-stat-value">{provider.avgLost.toFixed(1)}<small>lbs</small></p>
              <p className="fld-stat-detail">Across all active cohorts</p>
            </div>
            <div className="fld-stat">
              <div className="fld-stat-row"><span className="fld-stat-label"><ShieldAlert size={12} />Check-ins Overdue</span><span className="fld-tag warn">Needs review</span></div>
              <p className="fld-stat-value">{overdue}</p>
              <p className="fld-stat-detail">Patients at risk of dropping</p>
            </div>
          </section>

          {notice && overdue > 0 && (
            <div className="fld-banner" role="status">
              <ShieldAlert size={16} />
              <span><b>{overdue} patient{overdue === 1 ? ' needs' : 's need'} attention.</b> Check-ins or subscription renewals are past due.</span>
              <button type="button" className="fld-link" onClick={() => setToast('Opening Patients · status: overdue')}>Review patients</button>
              <button type="button" className="fld-dismiss" aria-label="Dismiss alert" onClick={() => setNotice(false)}><X size={13} /></button>
            </div>
          )}

          <div className="fld-row two">
            <section className="fld-card lift" aria-label="Revenue trend">
              <div className="fld-card-head">
                <div>
                  <p className="fld-eyebrow tight">Revenue Trend <span className="fld-tag mini">Demo projection</span></p>
                  <div className="fld-big-row">
                    <h3 className="fld-big">{money(revenue.total)}</h3>
                    <span className={`fld-delta${revenue.deltaPct < 0 ? ' down' : ''}`}>
                      {revenue.deltaPct >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                      {Math.abs(revenue.deltaPct).toFixed(1)}%
                    </span>
                  </div>
                  <p className="fld-meta">{dayLabel(range.days - 1)} – {dayLabel(0)} · vs prior {range.days} days</p>
                </div>
                <button type="button" className="fld-icon-btn ghost" aria-label="More chart options" onClick={() => setToast('Chart menu opened')}>
                  <MoreHorizontal size={16} />
                </button>
              </div>
              <div className="fld-chart" role="img" aria-label={`Revenue trend, ${revenue.buckets.length} periods, total ${money(revenue.total)}`}>
                <div className="fld-grid">
                  {[1, 0.75, 0.5, 0.25, 0].map((step) => (
                    <div key={step}><span>{step === 0 ? '0' : `$${Math.round((revenue.axisMax * step) / 1000)}k`}</span><i /></div>
                  ))}
                </div>
                <div className="fld-bars">
                  {revenue.buckets.map((b, index) => (
                    <div key={b.label} className={`fld-vbar${index === revenue.buckets.length - 1 ? ' now' : ''}`} style={{ height: `${Math.max(3, (b.total / revenue.axisMax) * 100)}%` }}>
                      <span>{b.label} · {money(b.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="fld-axis">
                {revenue.buckets.map((b) => <span key={b.label}>{b.label}</span>)}
              </div>
            </section>

            <section className="fld-card" aria-label="Protocol stages">
              <div className="fld-card-head">
                <div>
                  <p className="fld-eyebrow tight">Protocol Stages</p>
                  <h3 className="fld-title">{provider.active} Active</h3>
                </div>
                <button type="button" className="fld-link" onClick={() => setToast('Opening Revenue & Outcomes')}>Details <ArrowUpRight size={12} /></button>
              </div>
              <div className="fld-stages">
                {STAGES.map((s) => {
                  const pct = Math.round((s.count / totalStages) * 100);
                  return (
                    <div key={s.name} className="fld-stage-row">
                      <div><span>{s.name}</span><span className="fld-stage-num">{s.count} <b>{pct}%</b></span></div>
                      <div className="fld-track"><i className={s.tone} style={{ width: `${pct}%` }} /></div>
                    </div>
                  );
                })}
              </div>
              <p className="fld-stage-foot"><i className="fld-dot" />65 / 20 / 15 split · unchanged this week</p>
            </section>
          </div>

          <div className="fld-row three">
            <div className="fld-col">
              <section className="fld-card" aria-label="Priority items">
                <div className="fld-card-head">
                  <div>
                    <p className="fld-eyebrow tight">Priority items</p>
                    <h3 className="fld-title">Worth a closer look</h3>
                  </div>
                  <span className="fld-tag warn">{priority.length} open</span>
                </div>
                <ul className="fld-list">
                  {priority.map((item) => (
                    <li key={item.title}>
                      <button type="button" onClick={() => setToast(`${item.title} signal opened`)}>
                        <i className={`fld-sig ${item.tone}`} />
                        <span><b>{item.title}</b><small>{item.body}</small></span>
                        <em className={item.tone}>{item.level}</em>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="fld-card" aria-label="Logging compliance">
                <div className="fld-card-head">
                  <div>
                    <p className="fld-eyebrow tight">Logging compliance</p>
                    <h3 className="fld-title">Companion-app logging</h3>
                  </div>
                  <span className="fld-tag warn">{LAPSED.length} lapsed</span>
                </div>
                <div className="fld-note">
                  <span className="fld-note-icon"><ClipboardList size={15} /></span>
                  <p><b>{LAPSED.length}</b> patients haven&rsquo;t logged meals in the companion app for 3+ days.</p>
                </div>
                <ul className="fld-lapsed">
                  {LAPSED.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => setToast(`Opening ${p.name}`)}>
                        <i>{p.initials}</i><b>{p.name}</b><span>{p.days}d silent</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="fld-outline" onClick={() => setToast('Opening Patients · logging: lapsed')}>
                  Review lapsed loggers <ArrowUpRight size={12} />
                </button>
              </section>
            </div>

            <section className="fld-card" aria-label="Patient watchlist">
              <div className="fld-card-head">
                <div>
                  <p className="fld-eyebrow tight">Patient watchlist</p>
                  <h3 className="fld-title">Recent Check-ins &amp; Overdue</h3>
                </div>
                <button type="button" className="fld-link" onClick={() => setToast('Opening the full roster')}>View all roster <ArrowUpRight size={12} /></button>
              </div>
              {watchlist.length === 0 ? (
                <p className="fld-empty">No patients in this provider view.</p>
              ) : (
                <table className="fld-table">
                  <thead>
                    <tr><th>Patient</th><th>Provider</th><th>Stage</th><th>Status</th><th className="r">Weight Loss</th></tr>
                  </thead>
                  <tbody>
                    {watchlist.map((p) => (
                      <tr key={p.id}>
                        <td><button type="button" className="fld-name" onClick={() => setToast(`Opening ${p.name}`)}>{p.name}</button></td>
                        <td className="mut">{PROVIDERS.find((pr) => pr.id === p.providerId)?.short}</td>
                        <td className="mut">{p.stage}</td>
                        <td><span className={`fld-badge ${STATUS_TONE[p.status]}`}><i />{p.status}</span></td>
                        <td className="r mono">{p.lost.toFixed(1)} lbs</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="fld-card fld-team" aria-label="Recent activity">
            <div className="fld-card-head">
              <div>
                <p className="fld-eyebrow tight">Recent activity</p>
                <h3 className="fld-title">Team movement</h3>
              </div>
              <button type="button" className="fld-outline slim" onClick={() => setToast('Full activity log opened')}>Full activity</button>
            </div>
            <div className="fld-activity">
              {ACTIVITY.map((a) => (
                <button key={a.time} type="button" onClick={() => setToast(`${a.name}\u2019s activity opened`)}>
                  <i className={a.tone}>{a.initials}</i>
                  <span><b>{a.name}</b> {a.action}<small>{a.time}</small></span>
                </button>
              ))}
            </div>
          </section>

          <p className="fld-foot">THINNR Operations <X size={9} /> operations desk <X size={9} /> synthetic demo data</p>
        </div>

        <span className="fld-chip sync"><i />Synced 08:14 · all clear</span>

        {toast && (
          <div className="fld-toast" role="status">
            <i className="fld-dot" />
            {toast}
          </div>
        )}
      </div>
    </main>
  );
}
