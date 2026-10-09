/**
 * HQ Customer health — every active practice stack-ranked by a health score,
 * grouped by how recently it last ordered, with the offices trending toward
 * inactive called out so an account manager can decide who to call this week.
 *
 * Four order-recency tiles (Active, Quiet 3–6 months, Quiet 6–12 months,
 * Quiet over a year / never) plus a "Needs attention this week" tile; clicking
 * a tile narrows the table to that group. The ranked table sorts on every
 * column. Filter and sort live in the URL (`?group=&sort=&dir=`) so a shared
 * link restores the view. A "Pay attention this week" section lists the
 * flagged offices with their reasons, worst score first, and a definitions
 * note spells out every rule from the constants the server scored with.
 *
 * A personal "Email me this summary every Monday at 9am ET" switch lets any
 * HQ member subscribe themselves to the weekly email; it reads and saves the
 * caller's own preference immediately. The "vs last week" column compares
 * each score with the Monday weekly run's snapshot and reads "—" until the
 * first run exists.
 *
 * Figures are as of now — the page does not read the shared date range.
 * Signed-in HQ only: the score, buckets and flags are computed on the server;
 * loading and failure are explicit and a failed load never shows zeros.
 */
import { useMemo, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { AlertCircle, Mail, RefreshCw, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { CustomerHealthOffice, CustomerHealthResult, HqWeeklyCustomerHealthEmailPreference } from '@workspace/api-client-react';
import {
  getGetHqCustomerHealthQueryKey,
  getGetHqWeeklyCustomerHealthEmailPreferenceQueryKey,
  useGetHqCustomerHealth,
  useGetHqWeeklyCustomerHealthEmailPreference,
  useSetHqWeeklyCustomerHealthEmailPreference,
} from '@workspace/api-client-react';
import { Link } from 'wouter';
import { BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { Switch } from '@/components/ui/switch';
import { BandPill, CustomerHealthTable, NewBadge, ScoreChange } from '@/components/admin/CustomerHealthTable';
import { useSession } from '@/contexts/session';
import { formatLocalDate } from '@/lib/local-time';
import { formatUpdatedAt } from '@/lib/app-usage';
import {
  BUCKET_DETAIL,
  BUCKET_LABELS,
  BUCKET_ORDER,
  CUSTOMER_HEALTH_PATH,
  GROUP_LABELS,
  countFlagged,
  filterHealthRows,
  formatCount,
  formatDaysAgo,
  healthDefinitions,
  healthSearchFor,
  nextSort,
  parseHealthSearch,
  sortHealthRows,
  type HealthGroup,
  type HealthSortKey,
  type HealthUrlState,
} from '@/lib/customer-health';

export type CustomerHealthViewState = 'loading' | 'error' | 'ready';

interface CustomerHealthViewProps {
  state: CustomerHealthViewState;
  data: CustomerHealthResult | undefined;
  updatedLabel: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  urlState: HealthUrlState;
  onUrlState: (next: HealthUrlState) => void;
  /** The personal weekly-email switch, rendered under the tiles (owned by the page so the view stays pure). */
  weeklyEmail?: ReactNode;
}

export const WEEKLY_EMAIL_LABEL = 'Email me this summary every Monday at 9am ET';

export type WeeklyEmailToggleState = 'loading' | 'error' | 'ready';

interface WeeklyEmailToggleProps {
  state: WeeklyEmailToggleState;
  enabled: boolean;
  saving: boolean;
  saveFailed: boolean;
  onChange: (enabled: boolean) => void;
  onRetry: () => void;
  /** ISO week of the snapshot today's scores are compared with, or null before the first weekly run. */
  priorSnapshotWeek: string | null | undefined;
}

/** The caller's own Monday-email switch: shows the saved state, saves on every flip, and never pretends to know the state while it loads. */
export function WeeklyEmailToggle({ state, enabled, saving, saveFailed, onChange, onRetry, priorSnapshotWeek }: WeeklyEmailToggleProps) {
  const loading = state === 'loading';
  const failed = state === 'error';
  const status = loading
    ? 'Checking your setting…'
    : failed
      ? 'Could not load your setting.'
      : saving
        ? 'Saving…'
        : enabled
          ? 'On — you get the counts, the offices to watch and why, every Monday morning.'
          : 'Off — turn on to get the counts and the offices to watch every Monday morning.';
  const comparison = priorSnapshotWeek === undefined
    ? null
    : priorSnapshotWeek === null
      ? 'No weekly run yet — "vs last week" reads — until the first Monday run.'
      : `"vs last week" compares with the Monday run for week ${priorSnapshotWeek}.`;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-card-border bg-card px-4 py-3 shadow-soft" data-testid="card-health-weekly-email" data-state={state}>
      <div className="flex min-w-0 items-start gap-3">
        <Mail size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <label htmlFor="switch-health-weekly-email" className="block text-xs font-semibold text-navy">{WEEKLY_EMAIL_LABEL}</label>
          <p className={`mt-0.5 text-[11px] ${failed ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="text-health-weekly-email-status" aria-live="polite">
            {status}
            {failed && (
              <>
                {' '}
                <button type="button" className="underline" onClick={onRetry} data-testid="button-health-weekly-email-retry">Try again</button>
              </>
            )}
            {saveFailed && !saving && !failed && (
              <span className="text-destructive" data-testid="text-health-weekly-email-save-error"> Your change was not saved — try again.</span>
            )}
          </p>
          {comparison && <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="text-health-prior-week">{comparison}</p>}
        </div>
      </div>
      <Switch
        id="switch-health-weekly-email"
        checked={enabled}
        onCheckedChange={onChange}
        disabled={loading || failed || saving}
        aria-label={WEEKLY_EMAIL_LABEL}
        data-testid="switch-health-weekly-email"
      />
    </div>
  );
}

/** A metric tile that doubles as the group filter (aria-pressed when it is the current narrowing). */
function GroupTile({ group, label, value, detail, pressed, onPress, tone = 'default' }: {
  group: HealthGroup;
  label: string;
  value: string;
  detail: string;
  pressed: boolean;
  onPress: () => void;
  tone?: 'default' | 'warm';
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={pressed}
      className={`rounded-lg border p-4 text-left shadow-soft transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        pressed ? 'border-primary bg-accent/40' : tone === 'warm' ? 'border-[#e8b47c] bg-[#fff8ef] hover:bg-[#fff4e6]' : 'border-card-border bg-card hover:bg-accent/30'
      }`}
      data-testid={`tile-health-${group}`}
      data-group={group}
    >
      <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p>
      <p className={`mt-2 font-serif text-[26px] font-bold leading-none tracking-[-.01em] ${tone === 'warm' ? 'text-[#b65c22]' : 'text-navy'}`} data-testid={`text-health-${group}`}>
        {value}
      </p>
      <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>
    </button>
  );
}

export function CustomerHealthView({ state, data, updatedLabel, refreshing, onRefresh, urlState, onUrlState, weeklyEmail }: CustomerHealthViewProps) {
  const loading = state === 'loading';
  const failed = state === 'error';
  const rows = data?.offices ?? [];
  const { group, sort } = urlState;

  const visible = useMemo(() => sortHealthRows(filterHealthRows(rows, group), sort), [rows, group, sort]);
  const definitions = useMemo(() => (data ? healthDefinitions(data.definitions) : []), [data]);

  const tileValue = (value: number | undefined) => (loading ? '—' : failed ? 'Error' : value == null ? '—' : formatCount(value));
  const tileDetail = (ready: string) => (loading ? 'Loading live data…' : failed ? 'Failed to load' : ready);

  const setGroup = (next: HealthGroup) => onUrlState({ ...urlState, group: group === next ? null : next });
  const setSort = (key: HealthSortKey) => onUrlState({ ...urlState, sort: nextSort(sort, key) });

  const generatedLabel = data?.generatedAt ? formatLocalDate(data.generatedAt) : null;

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title="Customer health"
        sub={
          <>
            Every active practice ranked by how recently it ordered and how much its patients and staff use THINNR. Figures are as of now
            {generatedLabel && <> (<span data-testid="text-health-asof">{generatedLabel}</span>)</>}
            {updatedLabel && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1" data-testid="text-health-updated" aria-live="polite">
                  {refreshing && <RefreshCw size={11} aria-hidden="true" className="animate-spin" />}
                  {updatedLabel}
                </span>
              </>
            )}
          </>
        }
        action={
          <button
            type="button"
            className={`${BTN_SECONDARY} h-9 px-3.5`}
            onClick={onRefresh}
            disabled={loading || refreshing}
            aria-label="Refresh customer health"
            data-testid="button-health-refresh"
          >
            <RefreshCw size={13} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" role="group" aria-label="Order-recency groups — choose one to narrow the table">
        {BUCKET_ORDER.map((bucket) => (
          <GroupTile
            key={bucket}
            group={bucket}
            label={BUCKET_LABELS[bucket]}
            value={tileValue(data?.bucketCounts[bucket])}
            detail={tileDetail(BUCKET_DETAIL[bucket])}
            pressed={group === bucket}
            onPress={() => setGroup(bucket)}
          />
        ))}
        <GroupTile
          group="attention"
          label="Needs attention this week"
          value={tileValue(data ? countFlagged(data.offices) : undefined)}
          detail={tileDetail('Trending toward inactive')}
          pressed={group === 'attention'}
          onPress={() => setGroup('attention')}
          tone="warm"
        />
      </div>

      {weeklyEmail}

      {group && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs" data-testid="banner-health-group">
          <span className="text-muted-foreground">Showing:</span>
          <span className="font-semibold text-navy" data-testid="text-health-group-name">{GROUP_LABELS[group]}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-semibold text-navy transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onUrlState({ ...urlState, group: null })}
            data-testid="button-health-all-offices"
          >
            <X size={11} aria-hidden="true" /> Show all offices
          </button>
        </div>
      )}

      <div className="mt-5">
        <SectionCard
          title="Stack rank"
          sub={group ? `Offices in “${GROUP_LABELS[group]}”, ${visible.length} of ${rows.length}. Sort any column; rank always reads the network-wide position.` : 'Every active office, best score first. Sort any column; rank always reads the network-wide position.'}
        >
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-health-table-loading">Loading offices…</p>
          ) : failed ? (
            <div className="m-5">
              <ErrorNotice testId="text-health-table-error" onRetry={onRefresh} />
            </div>
          ) : (
            <CustomerHealthTable rows={visible} sort={sort} onSort={setSort} groupLabel={group ? GROUP_LABELS[group] : null} />
          )}
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard title="Pay attention this week" sub="Offices trending toward inactive, worst score first, with the reason each one was flagged.">
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-health-attention-loading">Loading…</p>
          ) : failed ? (
            <div className="m-5">
              <ErrorNotice testId="text-health-attention-error" onRetry={onRefresh} />
            </div>
          ) : (data?.attention.length ?? 0) === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-health-attention-empty">No office needs attention this week.</p>
          ) : (
            <ol className="divide-y divide-border" aria-label="Offices needing attention, worst score first" data-testid="list-health-attention">
              {data!.attention.map((office) => <AttentionRow key={office.providerId} office={office} />)}
            </ol>
          )}
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard title="How these numbers are counted" sub="Every figure on this page follows these rules; the weights and targets are the ones the score was computed with.">
          {loading ? (
            <p className="px-5 py-6 text-center text-xs text-muted-foreground" data-testid="text-health-definitions-loading">Loading…</p>
          ) : failed ? (
            <p className="px-5 py-6 text-center text-xs text-muted-foreground" data-testid="text-health-definitions-error">Definitions load with the figures.</p>
          ) : (
            <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2" data-testid="text-health-definitions">
              {definitions.map((definition) => (
                <div key={definition.term}>
                  <dt className="font-bold uppercase tracking-[.12em] text-navy">{definition.term}</dt>
                  <dd className="mt-0.5 max-w-[70ch]">{definition.text}</dd>
                </div>
              ))}
            </dl>
          )}
        </SectionCard>
      </div>
    </AdminPage>
  );
}

function AttentionRow({ office }: { office: CustomerHealthOffice }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-3" data-testid={`attention-health-${office.providerId}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/admin/accounts/${office.providerId}`}
            className="rounded-sm text-xs font-semibold text-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`link-attention-office-${office.providerId}`}
          >
            {office.officeName}
          </Link>
          {office.isNew && <NewBadge />}
          <span className="text-[10px] text-muted-foreground">Rank {office.rank} · {office.lastOrderAt ? `Last order ${formatDaysAgo(office.daysSinceLastOrder).toLowerCase()}` : 'No orders on record'}</span>
        </div>
        <ul className="mt-1 space-y-0.5 text-[11px] text-[#b65c22]" aria-label={`Why ${office.officeName} was flagged`}>
          {office.flags.map((flag) => <li key={flag.kind} data-flag={flag.kind}>{flag.reason}</li>)}
        </ul>
      </div>
      <span className="inline-flex items-center gap-2 tabular-nums">
        <b className="text-sm text-navy" data-testid={`attention-score-${office.providerId}`}>{office.score}</b>
        <BandPill band={office.band} />
        <ScoreChange change={office.scoreChange} testId={`attention-change-${office.providerId}`} className="text-[11px]" />
      </span>
    </li>
  );
}

function ErrorNotice({ testId, onRetry }: { testId: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid={testId}>
      <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        Customer health could not be loaded.{' '}
        <button type="button" className="underline" onClick={onRetry}>Try again</button>
      </span>
    </div>
  );
}

/** Filter + sort live in the URL, replace-navigated so Back is not spammed. */
function useHealthUrlState(): [HealthUrlState, (next: HealthUrlState) => void] {
  const search = useSearch();
  const [, navigate] = useLocation();
  const state = useMemo(() => parseHealthSearch(search), [search]);
  const set = (next: HealthUrlState) => navigate(`${CUSTOMER_HEALTH_PATH}${healthSearchFor(next, search)}`, { replace: true });
  return [state, set];
}

/** The caller's own weekly-email preference: identity-scoped read, immediate save, server value wins after every save. */
function useWeeklyEmailPreference(authUserId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = [...getGetHqWeeklyCustomerHealthEmailPreferenceQueryKey(), authUserId];
  const query = useGetHqWeeklyCustomerHealthEmailPreference({ query: { queryKey, retry: 1 } });
  const mutation = useSetHqWeeklyCustomerHealthEmailPreference({
    mutation: {
      onSuccess: (saved: HqWeeklyCustomerHealthEmailPreference) => { queryClient.setQueryData(queryKey, saved); },
    },
  });
  const state: WeeklyEmailToggleState = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';
  // While a save is in flight the switch shows what was asked for; a failed save falls back to the saved value.
  const enabled = mutation.isPending ? mutation.variables.data.enabled : (query.data?.enabled ?? false);
  return {
    state,
    enabled,
    saving: mutation.isPending,
    saveFailed: mutation.isError,
    set: (next: boolean) => { mutation.mutate({ data: { enabled: next } }); },
    retry: () => { void query.refetch(); },
  };
}

export default function CustomerHealth() {
  const { authUser } = useSession();
  const [urlState, setUrlState] = useHealthUrlState();
  const query = useGetHqCustomerHealth({
    query: {
      queryKey: [...getGetHqCustomerHealthQueryKey(), authUser?.id],
      retry: 1,
    },
  });
  const weekly = useWeeklyEmailPreference(authUser?.id);
  // A failed read is reported, never papered over with the previous figures.
  const state: CustomerHealthViewState = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';
  return (
    <CustomerHealthView
      weeklyEmail={
        <WeeklyEmailToggle
          state={weekly.state}
          enabled={weekly.enabled}
          saving={weekly.saving}
          saveFailed={weekly.saveFailed}
          onChange={weekly.set}
          onRetry={weekly.retry}
          priorSnapshotWeek={query.isError || query.isPending ? undefined : query.data?.priorSnapshotWeek}
        />
      }
      state={state}
      data={query.isError ? undefined : query.data}
      updatedLabel={query.isError ? null : formatUpdatedAt(query.dataUpdatedAt)}
      refreshing={query.isFetching && !query.isPending}
      onRefresh={() => { void query.refetch(); }}
      urlState={urlState}
      onUrlState={setUrlState}
    />
  );
}
