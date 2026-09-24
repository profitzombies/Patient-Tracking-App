/**
 * The HQ office access board: every live office, what state its access
 * subscription is in, and the dates that decide it.
 *
 * Filters and sort live in the query string, as on the other HQ list screens,
 * so a link to "everyone restricted" is a link anyone can share. Counts across
 * the top are what needs attention: offices in a recovery window, offices
 * restricted, and included periods ending soon.
 */
import { useLocation } from 'wouter';
import { AdminPage, MetricTile } from '@/components/admin/primitives';
import { StatusPill } from '@/components/billing/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useHqOfficeAccessBoard } from '@/hooks/use-billing';
import { formatCents, formatDate } from '@/lib/billing-format';
import {
  ACCESS_STATE_LABELS,
  NOT_STARTED,
  PLAN_LABELS,
  accessStateLabel,
  accessStateTone,
  boardState,
  sortBoard,
  trialEndingSoon,
  type BoardSort,
  type BoardState,
} from '@/lib/office-access';
import type { OfficeAccessBoard as Board, OfficeAccessBoardRow } from '@/lib/billing-types';
import { ErrorBox, Gate, Header, Preview, RowLink, clickable, useUrlFilters } from './shared';

/** The area is nest-mounted at /admin/payments, so paths here stay area-relative. */
const BASE = '/office-access';

/** Filter choices, in the order HQ works them: trouble first. */
const STATE_FILTERS: { value: BoardState | 'all' | 'ending_soon'; label: string }[] = [
  { value: 'all', label: 'All offices' },
  { value: 'restricted', label: ACCESS_STATE_LABELS.restricted },
  { value: 'past_due', label: ACCESS_STATE_LABELS.past_due },
  { value: 'ending_soon', label: 'Trial ending soon' },
  { value: 'included_period', label: ACCESS_STATE_LABELS.included_period },
  { value: 'setup_incomplete', label: ACCESS_STATE_LABELS.setup_incomplete },
  { value: 'paid_current', label: ACCESS_STATE_LABELS.paid_current },
  { value: NOT_STARTED, label: ACCESS_STATE_LABELS.not_started },
];

const SORTS: { value: BoardSort; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'next', label: 'Next date' },
  { value: 'name', label: 'Office name' },
];

export function filterBoard(rows: OfficeAccessBoardRow[], state: string, endingSoonDays: number, now = new Date()): OfficeAccessBoardRow[] {
  if (state === 'all' || !state) return rows;
  if (state === 'ending_soon') return rows.filter((row) => trialEndingSoon(row, endingSoonDays, now));
  return rows.filter((row) => boardState(row) === state);
}

export function PaymentsOfficeAccess() {
  return <Gate>{(demo) => (demo ? <DemoBoard /> : <BoardBody />)}</Gate>;
}

function BoardHeader() {
  return (
    <Header
      kicker="Office access"
      title="Office access billing"
      sub="What each office pays THINNR for the platform, and which offices need attention."
    />
  );
}

function DemoBoard() {
  return (
    <AdminPage>
      <BoardHeader />
      <Preview />
    </AdminPage>
  );
}

function BoardBody() {
  const query = useHqOfficeAccessBoard();
  const { params, set } = useUrlFilters(BASE);
  const [, navigate] = useLocation();
  const state = params.get('state') ?? 'all';
  const sort = (SORTS.find((option) => option.value === params.get('sort'))?.value ?? 'attention') as BoardSort;

  return (
    <AdminPage>
      <BoardHeader />
      {query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <Counts board={query.data} active={state} onPick={(value) => set('state', value === 'all' ? '' : value)} />
          <div className="mb-3 mt-5 flex flex-wrap items-center gap-2">
            <Select value={state} onValueChange={(value) => set('state', value === 'all' ? '' : value)}>
              <SelectTrigger className="h-9 w-52 text-xs" aria-label="Filter by access state" data-testid="select-access-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATE_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(value) => set('sort', value === 'attention' ? '' : value)}>
              <SelectTrigger className="h-9 w-44 text-xs" aria-label="Sort offices" data-testid="select-access-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <BoardTable
            rows={sortBoard(filterBoard(query.data.offices, state, query.data.trialEndingSoonDays), sort)}
            navigate={navigate}
          />
        </>
      ) : null}
    </AdminPage>
  );
}

function Counts({ board, active, onPick }: { board: Board; active: string; onPick: (state: string) => void }) {
  const tiles: { key: string; label: string; value: number; detail: string }[] = [
    { key: 'all', label: 'Offices', value: board.counts.total, detail: 'Live offices on the platform' },
    { key: 'past_due', label: 'In grace', value: board.counts.pastDue, detail: `Recovery window is ${board.policy.gracePeriodDays} days` },
    { key: 'restricted', label: 'Restricted', value: board.counts.restricted, detail: `Earning at ${board.policy.restrictedSharePercent}%` },
    { key: 'ending_soon', label: 'Trials ending soon', value: board.counts.trialsEndingSoon, detail: `Within ${board.trialEndingSoonDays} days` },
    { key: NOT_STARTED, label: 'Not started', value: board.counts.notStarted, detail: 'No subscription work yet' },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {tiles.map((tile) => (
        <button
          key={tile.key}
          type="button"
          onClick={() => onPick(tile.key)}
          aria-pressed={active === tile.key || (tile.key === 'all' && active === 'all')}
          className={`rounded-md text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            active === tile.key ? 'ring-2 ring-primary' : ''
          }`}
          data-testid={`tile-access-${tile.key}`}
        >
          <MetricTile label={tile.label} value={tile.value.toLocaleString('en-US')} detail={tile.detail} />
        </button>
      ))}
    </div>
  );
}

function BoardTable({ rows, navigate }: { rows: OfficeAccessBoardRow[]; navigate: (to: string) => void }) {
  if (!rows.length) {
    return (
      <p className="rounded-md border border-border bg-paper-alt px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-access-board-empty">
        No office is in that state right now.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-paper">
      <table className="w-full min-w-[46rem] text-left text-xs">
        <thead className="border-b border-border text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5">Office</th>
            <th scope="col" className="px-4 py-2.5">Access</th>
            <th scope="col" className="px-4 py-2.5">Plan</th>
            <th scope="col" className="px-4 py-2.5">Next charge / period end</th>
            <th scope="col" className="px-4 py-2.5">Grace</th>
            <th scope="col" className="px-4 py-2.5 text-right">Account</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // `~` escapes the nested payments base: the account page lives outside this area.
            const href = `~/admin/accounts/${row.providerId}`;
            return (
              <tr
                key={row.providerId}
                onClick={clickable(navigate, href)}
                className="cursor-pointer border-b border-border last:border-b-0 hover:bg-secondary/60"
                data-testid={`row-access-office-${row.providerId}`}
              >
                <td className="px-4 py-2.5 font-semibold text-navy">{row.officeName}</td>
                <td className="px-4 py-2.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusPill tone={accessStateTone(row.state)} testId={`chip-access-state-${row.providerId}`}>
                      {accessStateLabel(row.state)}
                    </StatusPill>
                    {row.lifetime && <StatusPill tone="info">Lifetime</StatusPill>}
                    {row.locked && <StatusPill tone="bad">Locked</StatusPill>}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {row.plan ? `${PLAN_LABELS[row.plan]} · ${formatCents(row.priceCents)}` : '—'}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground" data-testid={`text-access-next-${row.providerId}`}>
                  {row.lifetime ? 'None' : formatDate(row.nextChargeAt ?? row.includedPeriodEndsAt) || '—'}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                  {row.graceDaysLeft === null ? '—' : `${row.graceDaysLeft} days left`}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <RowLink href={href} label={`Open ${row.officeName}`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
