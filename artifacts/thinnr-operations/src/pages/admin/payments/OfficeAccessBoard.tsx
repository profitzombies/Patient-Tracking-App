/**
 * App payments: the money offices pay THINNR for the app. Which offices are
 * billable, when each is charged, what is on file to charge, how long each
 * trial has left, what the coming charges should bring in, and what actually
 * came in — plus CSV reports kept apart from patient shop sales.
 *
 * Filters, the forecast window and the history range live in the query
 * string, as on the other HQ list screens, so any view is a shareable link.
 * Signed out, the page shows believable sample data pinned to the demo date.
 */
import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { AdminPage, MetricTile } from '@/components/admin/primitives';
import { StatusPill } from '@/components/billing/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useHqAppPaymentsCollected, useHqAppPaymentsForecast, useHqOfficeAccessBoard } from '@/hooks/use-billing';
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
import {
  FLAG_LABELS,
  LAST_PAYMENT_LABELS,
  WITHIN_CHOICES,
  bankStatusLabel,
  defaultBucket,
  filterOffices,
  flagsOf,
  forecastWindow,
  hasPaymentProblem,
  historyWindow,
  instrumentLabel,
  parseHistoryChoice,
  parseProblem,
  parseWindowChoice,
  parseWithin,
  type OfficeFilters,
} from '@/lib/app-payments';
import { DEMO_TODAY_KEY } from '@/lib/date-range-keys';
import type { AppPaymentFlag, AppPaymentsCollected, AppPaymentsForecast, OfficeAccessBoard as Board, OfficeAccessBoardRow } from '@/lib/billing-types';
import { CollectedSection, ForecastSection, WindowPicker, loaded, type Loadable } from './AppPaymentsForecast';
import { AppPaymentsReports } from './AppPaymentsReports';
import { DEMO_NOW, demoBoard, demoCollected, demoForecast } from './app-payments-demo';
import { ErrorBox, Gate, Header, Preview, RowLink, clickable, useUrlFilters } from './shared';
import { useBillingSandbox } from './use-billing-sandbox';

/** The area is nest-mounted at /admin/payments, so paths here stay area-relative. */
const BASE = '/office-access';

/** Filter choices, in the order HQ works them: trouble first. */
const STATE_FILTERS: { value: BoardState | 'all' | 'ending_soon'; label: string }[] = [
  { value: 'all', label: 'All offices' },
  { value: 'restricted', label: ACCESS_STATE_LABELS.restricted },
  { value: 'past_due', label: ACCESS_STATE_LABELS.past_due },
  { value: 'ending_soon', label: 'Trial ending soon' },
  { value: 'included_period', label: 'In trial' },
  { value: 'setup_incomplete', label: ACCESS_STATE_LABELS.setup_incomplete },
  { value: 'paid_current', label: 'Paid current' },
  { value: NOT_STARTED, label: ACCESS_STATE_LABELS.not_started },
];

const SORTS: { value: BoardSort; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'next', label: 'Next charge date' },
  { value: 'trial', label: 'Trial ending first' },
  { value: 'amount', label: 'Largest next charge' },
  { value: 'name', label: 'Office name' },
];

const PROBLEM_FILTERS: { value: string; label: string }[] = [
  { value: 'problem-all', label: 'Any payment status' },
  { value: 'problem-any', label: 'Any payment problem' },
  ...(Object.keys(FLAG_LABELS) as AppPaymentFlag[]).map((flag) => ({ value: `problem-${flag}`, label: FLAG_LABELS[flag] })),
];

/** Kept for the office access regression script: the plain state filter. */
export function filterBoard(rows: OfficeAccessBoardRow[], state: string, endingSoonDays: number, now = new Date()): OfficeAccessBoardRow[] {
  return filterOffices(rows, { state, trialWithin: null, dueWithin: null, problem: null }, endingSoonDays, now);
}

export function PaymentsOfficeAccess() {
  return <Gate>{(demo) => <AppPaymentsPage demo={demo} />}</Gate>;
}

/** Today's UTC day key: the server's charge dates are UTC. */
const utcToday = () => new Date().toISOString().slice(0, 10);

function AppPaymentsPage({ demo }: { demo: boolean }) {
  const sandbox = useBillingSandbox();
  const { params, set } = useUrlFilters(BASE);
  const today = demo ? DEMO_TODAY_KEY : utcToday();
  const now = demo ? DEMO_NOW : new Date();

  // ---- forecast window ----
  const choice = parseWindowChoice(params.get('win'));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const window = forecastWindow(choice, today, { from, to });
  const bucketParam = params.get('bucket');
  const bucket = bucketParam === 'week' || bucketParam === 'month' ? bucketParam : window ? defaultBucket(window) : 'week';
  const history = parseHistoryChoice(params.get('hist'));
  const past = historyWindow(history, today);

  // Live queries sit idle in demo mode (the scope disables them).
  const liveBoard = useHqOfficeAccessBoard();
  const liveForecast = useHqAppPaymentsForecast({ start: window?.start ?? today, end: window?.end ?? today, bucket }, Boolean(window));
  const liveCollected = useHqAppPaymentsCollected(past);

  const demoData = useMemo(
    () => (demo ? { board: demoBoard(), forecast: window ? demoForecast(window, bucket) : null, collected: demoCollected(past) } : null),
    [demo, window?.start, window?.end, bucket, past.start, past.end],
  );
  const board: Loadable<Board> = demoData ? loaded(demoData.board) : liveBoard;
  const forecast: Loadable<AppPaymentsForecast> | null = !window
    ? null
    : demoData?.forecast ? loaded(demoData.forecast) : liveForecast;
  const collected: Loadable<AppPaymentsCollected> = demoData ? loaded(demoData.collected) : liveCollected;

  return (
    <AdminPage>
      <Header
        title="App payments"
        sub="What each office pays THINNR for the app: who is billable, what is on file, what is coming, and what came in."
        sandbox={demo ? undefined : sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      <OfficesSection board={board} now={now} params={params} set={set} />
      <ForecastSection
        forecast={forecast}
        windowError={!window}
        windowPicker={
          <WindowPicker
            choice={choice}
            window={window}
            bucket={bucket}
            from={from || today}
            to={to}
            onChoice={(value) => set('win', value === '90' ? '' : value)}
            onCustom={(key, value) => set(key, value)}
            onBucket={(value) => set('bucket', value)}
          />
        }
      />
      <CollectedSection
        collected={collected}
        charges={forecast?.data?.charges ?? []}
        history={history}
        onHistory={(value) => set('hist', value === '6m' ? '' : value)}
      />
      <AppPaymentsReports demo={demo} forecastWindow={window} historyWindow={past} />
    </AdminPage>
  );
}

function OfficesSection({
  board, now, params, set,
}: {
  board: Loadable<Board>;
  now: Date;
  params: URLSearchParams;
  set: (key: string, value: string) => void;
}) {
  const [, navigate] = useLocation();
  const state = params.get('state') ?? 'all';
  const sort = (SORTS.find((option) => option.value === params.get('sort'))?.value ?? 'attention') as BoardSort;
  const filters: OfficeFilters = {
    state,
    trialWithin: parseWithin(params.get('trial')),
    dueWithin: parseWithin(params.get('due')),
    problem: parseProblem(params.get('problem')),
  };

  if (board.isPending) return <Skeleton className="h-64 w-full" />;
  if (board.isError) return <ErrorBox error={board.error} retry={() => void board.refetch()} />;
  if (!board.data) return null;
  const data = board.data;
  const rows = sortBoard(filterOffices(data.offices, filters, data.trialEndingSoonDays, now), sort);

  return (
    <section aria-label="Billable offices">
      <Counts board={data} now={now} active={state} problem={filters.problem} onPick={(key) => {
        if (key === 'problems') set('problem', filters.problem === 'any' ? '' : 'any');
        else set('state', key === 'all' ? '' : key);
      }} />
      <div className="mb-3 mt-5 flex flex-wrap items-center gap-2">
        <Select value={state} onValueChange={(value) => set('state', value === 'all' ? '' : value)}>
          <SelectTrigger className="h-9 w-48 text-xs" aria-label="Filter by access state" data-testid="select-access-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATE_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={`trial-${filters.trialWithin ?? 'all'}`} onValueChange={(value) => set('trial', value === 'trial-all' ? '' : value.replace('trial-', ''))}>
          <SelectTrigger className="h-9 w-48 text-xs" aria-label="Trial ending within" data-testid="select-access-trial">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="trial-all" className="text-xs">Any trial end</SelectItem>
            {WITHIN_CHOICES.map((days) => (
              <SelectItem key={days} value={`trial-${days}`} className="text-xs">Trial ends within {days} days</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={`due-${filters.dueWithin ?? 'all'}`} onValueChange={(value) => set('due', value === 'due-all' ? '' : value.replace('due-', ''))}>
          <SelectTrigger className="h-9 w-48 text-xs" aria-label="Charge due within" data-testid="select-access-due">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="due-all" className="text-xs">Any charge date</SelectItem>
            {WITHIN_CHOICES.map((days) => (
              <SelectItem key={days} value={`due-${days}`} className="text-xs">Charge due within {days} days</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={`problem-${filters.problem ?? 'all'}`} onValueChange={(value) => set('problem', value === 'problem-all' ? '' : value.replace('problem-', ''))}>
          <SelectTrigger className="h-9 w-56 text-xs" aria-label="Payment problems" data-testid="select-access-problem">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROBLEM_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => set('sort', value === 'attention' ? '' : value)}>
          <SelectTrigger className="h-9 w-48 text-xs" aria-label="Sort offices" data-testid="select-access-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[11px] text-muted-foreground" data-testid="text-access-count">
          {rows.length} of {data.offices.length} offices
        </span>
      </div>
      <BoardTable rows={rows} navigate={navigate} />
    </section>
  );
}

function Counts({
  board, now, active, problem, onPick,
}: {
  board: Board;
  now: Date;
  active: string;
  problem: OfficeFilters['problem'];
  onPick: (key: string) => void;
}) {
  const problems = board.offices.filter(hasPaymentProblem).length;
  const trials = board.offices.filter((row) => trialEndingSoon(row, board.trialEndingSoonDays, now)).length;
  const tiles: { key: string; label: string; value: number; detail: string; pressed: boolean }[] = [
    { key: 'all', label: 'Offices', value: board.counts.total, detail: 'Live offices on the platform', pressed: active === 'all' },
    { key: 'past_due', label: 'In grace', value: board.counts.pastDue, detail: `Recovery window is ${board.policy.gracePeriodDays} days`, pressed: active === 'past_due' },
    { key: 'restricted', label: 'Restricted', value: board.counts.restricted, detail: `Earning at ${board.policy.restrictedSharePercent}%`, pressed: active === 'restricted' },
    { key: 'ending_soon', label: 'Trials ending soon', value: Math.max(board.counts.trialsEndingSoon, trials), detail: `Within ${board.trialEndingSoonDays} days`, pressed: active === 'ending_soon' },
    { key: 'problems', label: 'Payment problems', value: problems, detail: 'No method, expiring card or unverified bank', pressed: problem === 'any' },
    { key: NOT_STARTED, label: 'Not started', value: board.counts.notStarted, detail: 'No subscription work yet', pressed: active === NOT_STARTED },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <button
          key={tile.key}
          type="button"
          onClick={() => onPick(tile.key)}
          aria-pressed={tile.pressed}
          className={`rounded-md text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tile.pressed ? 'ring-2 ring-primary' : ''}`}
          data-testid={`tile-access-${tile.key}`}
        >
          <MetricTile label={tile.label} value={tile.value.toLocaleString('en-US')} detail={tile.detail} />
        </button>
      ))}
    </div>
  );
}

function OnFile({ row }: { row: OfficeAccessBoardRow }) {
  const instruments = row.instruments ?? [];
  const flags = hasPaymentProblem(row) ? flagsOf(row) : [];
  return (
    <div className="space-y-1">
      {instruments.length === 0 ? (
        <span className="text-muted-foreground">Nothing on file</span>
      ) : (
        instruments.map((instrument) => {
          const bank = bankStatusLabel(instrument);
          return (
            <p key={instrument.slot} className="whitespace-nowrap text-muted-foreground" data-testid={`text-access-instrument-${row.providerId}-${instrument.slot}`}>
              {instrumentLabel(instrument)}
              {bank && <span className={instrument.verificationStatus === 'verified' ? ' text-[#1f6b34]' : ' text-[#b65c22]'}> · {bank}</span>}
            </p>
          );
        })
      )}
      {flags.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {flags.map((flag) => (
            <StatusPill key={flag} tone="warn" testId={`flag-access-${flag}-${row.providerId}`}>{FLAG_LABELS[flag]}</StatusPill>
          ))}
        </span>
      )}
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
      <table className="w-full min-w-[64rem] text-left text-xs">
        <thead className="border-b border-border text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5">Office</th>
            <th scope="col" className="px-4 py-2.5">State</th>
            <th scope="col" className="px-4 py-2.5">Plan</th>
            <th scope="col" className="px-4 py-2.5">Trial</th>
            <th scope="col" className="px-4 py-2.5">Next charge</th>
            <th scope="col" className="px-4 py-2.5">On file</th>
            <th scope="col" className="px-4 py-2.5">Last payment</th>
            <th scope="col" className="px-4 py-2.5 text-right">Account</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // `~` escapes the nested payments base: the account page lives outside this area.
            const href = `~/admin/accounts/${row.providerId}`;
            const inTrial = row.state === 'included_period' && !row.lifetime && row.includedPeriodEndsAt;
            return (
              <tr
                key={row.providerId}
                onClick={clickable(navigate, href)}
                className="cursor-pointer border-b border-border align-top last:border-b-0 hover:bg-secondary/60"
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
                  {row.graceDaysLeft !== null && row.state === 'past_due' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{row.graceDaysLeft} grace days left</p>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {row.plan ? (
                    <>
                      {PLAN_LABELS[row.plan]} · {formatCents(row.priceCents)}
                      {row.priceCentsOverride !== null && <span className="block text-[11px]">HQ price</span>}
                    </>
                  ) : '—'}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground" data-testid={`text-access-trial-${row.providerId}`}>
                  {inTrial ? (
                    <>
                      {row.trialDaysLeft ?? '—'} days left
                      <span className="block text-[11px]">ends {formatDate(row.includedPeriodEndsAt)}</span>
                    </>
                  ) : '—'}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                  <span data-testid={`text-access-next-${row.providerId}`}>
                    {row.lifetime ? 'None' : formatDate(row.nextChargeAt ?? row.includedPeriodEndsAt) || '—'}
                  </span>
                  {!row.lifetime && row.nextChargeCents != null && (
                    <span className="block font-semibold text-navy" data-testid={`text-access-amount-${row.providerId}`}>
                      {formatCents(row.nextChargeCents)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5"><OnFile row={row} /></td>
                <td className="px-4 py-2.5" data-testid={`text-access-last-${row.providerId}`}>
                  {row.lastPayment ? (
                    <>
                      <StatusPill tone={row.lastPayment.outcome === 'failed' ? 'bad' : row.lastPayment.outcome === 'processing' ? 'info' : row.lastPayment.outcome === 'reversed' ? 'warn' : 'good'}>
                        {LAST_PAYMENT_LABELS[row.lastPayment.outcome]}
                      </StatusPill>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {formatCents(row.lastPayment.amountCents)} · {formatDate(row.lastPayment.at)}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">None yet</span>
                  )}
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
