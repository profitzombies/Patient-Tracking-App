import { useState, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { Search, ArrowUpDown, ChevronRight, Check, ShoppingBag, X } from "lucide-react";
import { useScopedPatients, useScopedProviders, useScopedSubscriptions } from "@/data/scoped-data";
import { getLoggingStats, isLapsed, lastLogLabel, type LoggingStats } from "@/data/nutrition-data";
import { MOCK_PRODUCTS } from "@/data/mock-data";
import { demoPurchasesSummary } from "@/components/office/PatientPurchases";
import { RosterFilterButton, RosterFilterChips, RosterQuickSets, RosterSortSelect } from "@/components/office/RosterFilters";
import { DEMO_TODAY_KEY, addDaysToKey, deviceTodayKey } from "@/lib/date-range-keys";
import {
  DEFAULT_ROSTER_SORT,
  activeQuickSet,
  builtInQuickSets,
  dateKeyOf,
  demoStatusToRoster,
  loadCustomQuickSets,
  matchesAllConditions,
  parseRosterView,
  programDayOn,
  programLabel,
  removeCustomQuickSet,
  saveCustomQuickSet,
  serializeRosterView,
  toRosterStatus,
  type FilterCondition,
  type QuickSet,
  type RosterFilterRow,
  type RosterSort,
  type RosterSortField,
  type RosterView,
} from "@/lib/roster-filters";
import { getNudgeAssessment } from "@/data/stall-nudge";
import { buildDemoAttentionItems } from "@/data/attention-demo";
import { isAttentionFirst, pinFlaggedFirst, withoutAttentionFirst } from "@/lib/patients-badge";
import { matchesPhoneQuery } from "@/lib/phone-digits";
import { usePatientSession } from "@/contexts/patient-session";
import { useLiveRoster } from "@/hooks/use-live-roster";
import { InvitePatientAction, InvitationChip, officeRosterQueryKey } from "@/components/office/LiveRoster";
import { OfficeGetTheAppPanel } from "@/components/office/GetTheAppPanel";
import { BTN_SECONDARY } from "@/components/patient/heritage";
import { resendInvitation, type OfficePatient, type OutreachRoster } from "@/lib/office-roster";
import { compareLiveLogging, isLiveLapsed, rosterActivityFor, type RosterActivity } from "@/lib/roster-activity";
import { LiveEngagementCell, LiveLoggingCell } from "@/components/office/RosterActivity";
import { OutreachChip } from "@/components/office/NotificationTimeline";
import { DeletedAccountsSection, DeletionChip } from "@/components/office/AccountDeletion";
import {
  useUpdateOfficePatientFollowUp,
  type PatientOperationalFollowUpReason,
} from '@workspace/api-client-react';
import { useToast } from "@/hooks/use-toast";

type SortField = RosterSortField;

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Heritage status tints — mirrors the mobile StatusBadge (thinnr-mobile
// constants/colors.ts): healthy stays in the cobalt family, watch and risk
// use the shared warm/risk tints that have no semantic token equivalents.
// `unknown` (live only: the activity aggregate had no row for the patient)
// is deliberately neutral — it is a data gap, not a risk state.
function StatusChip({ status }: { status: string }) {
  // Discharged is a closed record, not a risk: it reads in the quiet neutral
  // tint so it never competes with the outreach signals.
  const tone = status === 'active' || status === 'graduated' || status === 'on_track'
    ? 'border-accent-border bg-accent text-primary'
    : status === 'paused' || status === 'needs_attention' || status === 'invited'
      ? 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]'
      : status === 'discharged'
        ? 'border-border bg-secondary text-muted-foreground'
        : status === 'unknown'
          ? 'border-dashed border-border bg-secondary text-muted-foreground'
          : 'border-[#d5a7a7] bg-[#fff0f0] text-destructive';
  const displayStatus = status === 'unknown' ? 'activity unknown' : status.replace('_', ' ');
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${tone}`} title={status === 'unknown' ? 'Activity signals did not load for this patient' : undefined}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {displayStatus}
    </span>
  );
}

/**
 * Shop subscription signal. Live rows carry true/false from the billing
 * tables or null when they could not be read; null renders nothing rather
 * than "no subscription" (unknown is not a fact about the patient).
 */
function SubscriptionChip({ patientId }: { patientId: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-[#b9c8e8] bg-[#eef3ff] px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] text-[#2b4a8f]"
      title="Has an active shop subscription at this office"
      data-testid={`chip-subscription-${patientId}`}
    >
      <ShoppingBag size={10} aria-hidden="true" />
      Subscribed
    </span>
  );
}

const FOLLOW_UP_LABEL: Record<PatientOperationalFollowUpReason, string> = {
  check_in_overdue: 'Overdue',
  logging_lapsed: 'Lapsed',
  no_activity_14d: 'Inactive',
};

/**
 * One follow-up reason as a small toggle pill. Open reasons read in the warm
 * "watch" tint; clicking marks the follow-up reviewed, which mutes the pill
 * and adds a check so the reason stays visible (staff review never hides the
 * live risk). Clicking a reviewed pill reopens it.
 */
function FollowUpPill({ patientId, reason, currentStatus, office }: {
  patientId: string;
  reason: PatientOperationalFollowUpReason;
  currentStatus: 'open' | 'resolved';
  office: string | null;
}) {
  const updateFollowUp = useUpdateOfficePatientFollowUp();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isResolved = currentStatus === 'resolved';
  const spoken = reason.replaceAll('_', ' ');

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateFollowUp.mutate({
      patientId,
      reason,
      data: { status: isResolved ? 'open' : 'resolved' },
      params: office ? { office } : undefined
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: officeRosterQueryKey(office) });
        toast({ title: `Follow-up ${isResolved ? 'reopened' : 'resolved'}` });
      },
      onError: (error) => {
        toast({
          variant: 'destructive',
          title: 'Follow-up not saved',
          description: error instanceof Error ? error.message : 'Try again.',
        });
      },
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={updateFollowUp.isPending}
      aria-pressed={isResolved}
      aria-label={`Mark ${spoken} reviewed`}
      title={isResolved ? `Reviewed. Click to reopen the ${spoken} follow-up.` : `Click to mark ${spoken} reviewed.`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
        isResolved
          ? 'border-border bg-secondary text-muted-foreground line-through decoration-muted-foreground/60 hover:bg-muted'
          : 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22] hover:bg-[#ffe9d1]'
      }`}
    >
      {isResolved ? <Check size={9} strokeWidth={3} aria-hidden="true" /> : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {updateFollowUp.isPending ? 'Saving' : FOLLOW_UP_LABEL[reason] ?? spoken}
    </button>
  );
}

/** Status column body: exactly one chip, then the follow-up pills in one row. */
function StatusCell({ patient, office, align = 'left' }: {
  patient: { id: string; status: string; isLive: boolean; showResend: boolean; activeSubscription: boolean | null; rawLive?: OfficePatient };
  office: string | null;
  align?: 'left' | 'right';
}) {
  const reasons = patient.isLive ? patient.rawLive?.operational?.reasons ?? [] : [];
  return (
    <div className={`flex flex-col gap-1.5 ${align === 'right' ? 'items-end' : 'items-start'}`}>
      {patient.rawLive && <InvitationChip patient={patient.rawLive} />}
      {!patient.showResend && <StatusChip status={patient.status} />}
      {patient.activeSubscription === true && <SubscriptionChip patientId={patient.id} />}
      {patient.rawLive?.deletion && <DeletionChip deletion={patient.rawLive.deletion} testId={`chip-deletion-${patient.id}`} />}
      {reasons.length > 0 && (
        <div className={`flex flex-wrap gap-1 ${align === 'right' ? 'justify-end' : ''}`} onClick={(e) => e.stopPropagation()} data-testid={`follow-ups-${patient.id}`}>
          {reasons.map((reason) => {
            const followUp = patient.rawLive?.operational?.followUps?.find((item) => item.reason === reason);
            return <FollowUpPill key={reason} patientId={patient.id} reason={reason} currentStatus={followUp?.status ?? 'open'} office={office} />;
          })}
        </div>
      )}
    </div>
  );
}

// Guided-demo logging cell (seeded LoggingStats). Live rows render
// components/office/RosterActivity instead.
function LoggingSignal({ stats, align = 'left' }: { stats: LoggingStats; align?: 'left' | 'right' }) {
  const lapsed = isLapsed(stats);
  return (
    <div className={align === 'right' ? 'flex flex-col items-end' : ''} title={`${stats.loggedDays7} of the last 7 days logged in the companion app`}>
      <div className="flex items-center gap-2">
        <span className="flex gap-[3px]" aria-hidden="true">
          {stats.last7.map((logged, index) => (
            <span key={index} className={`h-2.5 w-2.5 rounded-[3px] ${logged ? 'bg-primary' : 'border border-border bg-secondary'}`} />
          ))}
        </span>
        <b className="font-mono text-xs font-semibold text-navy">{stats.loggedDays7}/7</b>
      </div>
      <span className={`mt-1 block text-[10px] ${lapsed ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{lastLogLabel(stats)}</span>
    </div>
  );
}

/**
 * Flags patients whose signals crossed the coach-outreach threshold (weight
 * stalled while the diary kept showing off-list items — the shared trigger
 * in data/stall-nudge.ts). Deliberately an ELIGIBILITY signal: the outreach
 * itself sends automatically in the patient's app with no approval step.
 * Live rows use the server's tracked delivery/engagement state; demo rows
 * retain the seeded eligibility-only signal.
 */
function NudgeChip({ outreach }: { outreach: OutreachRoster }) {
  return <OutreachChip outreach={outreach} />;
}

const DEMO_ELIGIBLE_OUTREACH: OutreachRoster = {
  state: 'eligible',
  eligible: true,
  crossedOnKey: null,
  evaluatedAt: null,
  lastSentKey: null,
  delivery: null,
  deliveryDetail: null,
  notificationId: null,
};

export default function Patients() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { getCurrentWeight } = usePatientSession();
  // One office's roster inside the HQ drill-in; the full program otherwise.
  const patients = useScopedPatients();
  const providers = useScopedProviders();
  const demoSubscriptions = useScopedSubscriptions();
  // Live invitations only exist for authenticated scopes: a signed-in
  // provider office (server derives the office from the bearer token) or an
  // HQ drill-in on an explicitly scoped account. Demo personas never call
  // the live endpoints, so the seeded demo stays untouched.
  const { data: liveRosterData, isLoading: liveRosterIsLoading, isError: liveRosterIsError, error: liveRosterError, liveEnabled, liveOffice } = useLiveRoster();
  // Base-aware navigate: resolves against the mount point exactly like the
  // roster's <Link>s, so row clicks stay inside the HQ drill-in scope too.
  const [location, navigate] = useLocation();
  const searchParams = useSearch();
  // Attention-first ordering lives in the URL only (`?attention=first`, set
  // by the amber Patients badge): reload and shared links keep it, and the
  // visible toggle clears it by rewriting the query string.
  const attentionFirst = isAttentionFirst(searchParams);
  const clearAttentionFirst = () => navigate(`${location}${withoutAttentionFirst(searchParams)}`, { replace: true });

  // Filters and sort are the URL's (`?f=field:op:value&sort=field.dir`), so a
  // view can be bookmarked or shared; older arriving links (`?status=`,
  // `?logging=lapsed`, `?reason=`, `?subscription=active`) still pre-apply
  // through the same parser and are rewritten as conditions on first change.
  const view = useMemo<RosterView>(() => parseRosterView(searchParams), [searchParams]);
  const conditions = view.conditions;
  const sortField: SortField = view.sort.field;
  const sortOrder = view.sort.order;
  const setView = useCallback(
    (next: RosterView) => navigate(`${location}${serializeRosterView(searchParams, next)}`, { replace: true }),
    [location, navigate, searchParams],
  );
  const setConditions = (next: FilterCondition[]) => setView({ conditions: next, sort: view.sort });
  const setSort = (sort: RosterSort) => setView({ conditions, sort });

  // "Today" for date-relative filters: the device day for real offices, the
  // fixed anchor for demo personas (their roster never moves).
  const today = liveEnabled ? deviceTodayKey() : DEMO_TODAY_KEY;

  const [customQuickSets, setCustomQuickSets] = useState<QuickSet[]>(() => loadCustomQuickSets(typeof window === 'undefined' ? null : window.localStorage));
  const quickSets = useMemo(() => [...builtInQuickSets(today), ...customQuickSets], [today, customQuickSets]);
  const currentQuickSet = activeQuickSet(quickSets, view);
  // Sets that carry a sort (Top spenders, Inactive / lapsed) apply it; the
  // rest keep the current sort, except All, which is the roster's home view
  // and returns it to the default order too.
  const applyQuickSet = (set: QuickSet) => setView({ conditions: set.conditions, sort: set.sort ?? (set.id === 'all' ? DEFAULT_ROSTER_SORT : view.sort) });
  const saveQuickSet = (name: string) => {
    const saved = saveCustomQuickSet(window.localStorage, name, view);
    setCustomQuickSets(saved.filter((set) => !set.builtIn));
    toast({ variant: 'success', title: `Quick set “${name.trim()}” saved`, description: 'Saved in this browser only.' });
  };
  const removeQuickSet = (set: QuickSet) => {
    setCustomQuickSets(removeCustomQuickSet(window.localStorage, set.id));
    toast({ title: `Quick set “${set.label}” removed` });
  };

  const [search, setSearch] = useState("");
  const [resending, setResending] = useState<string | null>(null);

  const resend = async (patient: OfficePatient) => {
    setResending(patient.id);
    try {
      const result = await resendInvitation(patient.id, liveOffice);
      await queryClient.invalidateQueries({ queryKey: officeRosterQueryKey(liveOffice) });
      toast({
        variant: result.invitation === 'sent' ? 'success' : 'destructive',
        title: result.invitation === 'sent' ? `Invitation resent to ${patient.name}` : 'Invitation email not sent',
        description: result.invitation === 'sent' ? 'The patient can use the invited phone number to connect.' : 'Try resending again once email delivery is available.',
      });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Invitation not resent', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setResending(null);
    }
  };

  const statsById = useMemo(
    () => new Map(patients.map((patient) => [patient.id, getLoggingStats(patient)])),
    [patients],
  );

  // Seeded subscriptions: paused and overdue ones are still open (the same
  // definition the live roster uses); cancelled ones are not.
  const demoSubscriptionActive = useMemo(
    () => new Map(demoSubscriptions.map((subscription) => [subscription.patientId, subscription.status !== 'cancelled'])),
    [demoSubscriptions],
  );
  // Seeded spend: the same totals the demo patient record's Purchases panel shows.
  const demoSpend = useMemo(
    () => new Map(patients.map((patient) => {
      const totals = demoPurchasesSummary(patient, demoSubscriptions.find((subscription) => subscription.patientId === patient.id), MOCK_PRODUCTS).totals;
      return [patient.id, { spentCents: totals.lifetime_net_cents, lastPaidDate: dateKeyOf(totals.last_paid_at) }];
    })),
    [patients, demoSubscriptions],
  );

  // Demo persona: the seeded attention rules the bell and the "Needs
  // attention" page share decide which rows the pin lifts to the top.
  const demoFlagged = useMemo(
    () => new Set(liveEnabled ? [] : buildDemoAttentionItems(patients).map((item) => item.patientId)),
    [liveEnabled, patients],
  );

  const unifiedRows = useMemo(() => {
    if (liveEnabled) {
      if (!liveRosterData) return [];
      return liveRosterData.patients.map(p => {
        const weightLoss = (p.program?.startingWeight != null && p.program?.currentWeight != null)
          ? p.program.startingWeight - p.program.currentWeight
          : 0;
        const percentLoss = p.program?.startingWeight ? ((weightLoss / p.program.startingWeight) * 100).toFixed(1) : "0.0";

        // Real per-patient signals from the office aggregate; an explicit
        // unknown state when the aggregate had no row (never zero-filled).
        const activity = rosterActivityFor(p);

        const startDate = p.startDate ?? p.program?.startDate ?? p.createdAt ?? '';
        const stageDisplay = p.program?.stage ? (p.program.stage === 'protocol' && p.program.week ? `Week ${p.program.week}` : 'Maintenance') : p.program?.id ? 'Enrolled' : '—';

        const nameParts = p.name.split(' ');
        const initials = nameParts.length > 1 ? `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}` : p.name.substring(0, 2).toUpperCase();

        const showResend = p.invitation?.state === 'pending';

        const status = toRosterStatus(p.operational?.status ?? p.status ?? 'invited');
        const programStartDate = dateKeyOf(p.program?.startDate ?? p.startDate);
        const spentCents = p.spend === undefined || p.spend === null ? null : p.spend.netCents;
        const filterRow: RosterFilterRow = {
          status,
          programId: p.program?.id ?? null,
          stage: p.program?.stage ?? null,
          week: p.program?.week ?? null,
          programDay: p.program?.day ?? programDayOn(programStartDate, today),
          joinDate: dateKeyOf(p.createdAt),
          programStartDate,
          startingWeight: p.program?.startingWeight ?? p.startingWeight ?? null,
          currentWeight: p.program?.currentWeight ?? p.currentWeight ?? null,
          spentCents,
          lastPaidDate: p.spend ? dateKeyOf(p.spend.lastPaidAt) : null,
          activeSubscription: p.activeSubscription ?? null,
          lastActivityDate: dateKeyOf(p.operational?.latestActivityDate),
          lastLogDate: dateKeyOf(p.operational?.latestDiaryDate ?? p.program?.lastLogDate ?? p.lastLogAt),
          // The server's own lapsed verdict; unknown when the aggregate had no row.
          loggingLapsed: activity.kind === 'unknown' ? null : isLiveLapsed(activity),
          attentionReasons: p.operational?.reasons ?? [],
        };

        return {
          id: p.id,
          filterRow,
          spentCents,
          name: p.name,
          initials,
          email: p.email,
          phone: p.phone,
          phoneDisplay: p.phoneDisplay,
          // Shared attention evaluator verdict (the bell / Needs attention set).
          attentionFlagged: p.attention?.flagged === true,
          status: p.operational?.status ?? p.status ?? 'invited',
          stageDisplay,
          providerName: p.providerName ?? '—',
          startDate,
          startDateDisplay: startDate ? formatDate(startDate) : '—',
          weightLoss,
          weightLossDisplay: weightLoss ? `${weightLoss.toFixed(1)} lbs` : '—',
          percentLossDisplay: weightLoss ? `${percentLoss}%` : '',
          stats: null as LoggingStats | null,
          activity: activity as RosterActivity | null,
          medicationAdherence: p.medicationAdherence ?? null,
          // Billing signal: true/false from the server, null when it could not be read.
          activeSubscription: p.activeSubscription ?? null,
          outreachChip: !p.outreach || p.outreach.state === 'none' ? null : p.outreach,
          isLive: true as boolean,
          showResend,
          rawLive: p
        };
      });
    }

    return patients.map(p => {
      const provider = providers.find(c => c.id === p.providerId);
      const weightLoss = p.startingWeight - getCurrentWeight(p);
      const percentLoss = ((weightLoss / p.startingWeight) * 100).toFixed(1);
      const stats = statsById.get(p.id)!;
      const spend = demoSpend.get(p.id) ?? { spentCents: 0, lastPaidDate: null };
      const filterRow: RosterFilterRow = {
        status: demoStatusToRoster(p.status),
        programId: 'thinnr',
        stage: p.stage,
        week: p.stage === 'protocol' ? p.protocolWeek : null,
        programDay: programDayOn(dateKeyOf(p.startDate), DEMO_TODAY_KEY),
        joinDate: dateKeyOf(p.startDate),
        programStartDate: dateKeyOf(p.startDate),
        startingWeight: p.startingWeight,
        currentWeight: getCurrentWeight(p),
        spentCents: spend.spentCents,
        lastPaidDate: spend.lastPaidDate,
        activeSubscription: demoSubscriptionActive.get(p.id) ?? false,
        lastActivityDate: stats.daysSinceLastLog == null ? null : addDaysToKey(DEMO_TODAY_KEY, -stats.daysSinceLastLog),
        lastLogDate: stats.daysSinceLastLog == null ? null : addDaysToKey(DEMO_TODAY_KEY, -stats.daysSinceLastLog),
        loggingLapsed: isLapsed(stats),
        attentionReasons: [],
      };
      return {
        id: p.id,
        filterRow,
        spentCents: spend.spentCents,
        name: p.name,
        initials: p.initials,
        email: p.email,
        phone: p.phone,
        phoneDisplay: null as string | null,
        attentionFlagged: demoFlagged.has(p.id),
        status: p.status,
        stageDisplay: p.stage === 'protocol' ? `Week ${p.protocolWeek}` : 'Maintenance',
        providerName: provider?.name.split(',')[0] ?? '—',
        startDate: p.startDate,
        startDateDisplay: formatDate(p.startDate),
        weightLoss,
        weightLossDisplay: `${weightLoss.toFixed(1)} lbs`,
        percentLossDisplay: `${percentLoss}%`,
        stats: stats as LoggingStats | null,
        activity: null as RosterActivity | null,
        medicationAdherence: null,
        activeSubscription: demoSubscriptionActive.get(p.id) ?? false,
        outreachChip: getNudgeAssessment(p).active ? DEMO_ELIGIBLE_OUTREACH : null,
        isLive: false as boolean,
        showResend: false,
        rawLive: undefined
      };
    });
  }, [liveEnabled, liveRosterData, patients, providers, getCurrentWeight, statsById, demoSubscriptionActive, demoSpend, demoFlagged, today]);

  // Program options come from the roster itself (whatever programs the office runs).
  const programOptions = useMemo(() => {
    const ids = Array.from(new Set(unifiedRows.map((row) => row.filterRow.programId).filter((id): id is string => id != null))).sort();
    return ids.map((id) => ({ value: id, label: programLabel(id) }));
  }, [unifiedRows]);

  const filteredAndSortedPatients = useMemo(() => {
    let result = unifiedRows.filter(p => {
      // Name and email match the typed text; a query carrying digits also
      // matches the phone by digit substring, whatever the formatting.
      const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
                            (p.email ?? '').toLowerCase().includes(search.toLowerCase()) ||
                            matchesPhoneQuery(search, p.phone, p.phoneDisplay);
      // Every stacked condition must match (see lib/roster-filters for the
      // vocabulary: "active" = activated account, unknown facts never match).
      return matchesSearch && matchesAllConditions(p.filterRow, conditions, today);
    });

    result.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'startDate') {
        const timeA = a.startDate ? new Date(a.startDate).getTime() : 0;
        const timeB = b.startDate ? new Date(b.startDate).getTime() : 0;
        comparison = timeA - timeB;
      } else if (sortField === 'status') {
        comparison = a.status.localeCompare(b.status);
      } else if (sortField === 'weightLoss') {
        comparison = a.weightLoss - b.weightLoss;
      } else if (sortField === 'spent') {
        // Unknown spend sinks to the bottom in either direction.
        if (a.spentCents == null || b.spentCents == null) {
          if (a.spentCents == null && b.spentCents == null) return 0;
          return a.spentCents == null ? 1 : -1;
        }
        comparison = a.spentCents - b.spentCents;
      } else if (sortField === 'logging') {
        if (a.activity || b.activity) {
          // Live: unknown rates sink to the bottom in either direction.
          return compareLiveLogging(a.activity ?? { kind: 'unknown' }, b.activity ?? { kind: 'unknown' }, sortOrder);
        }
        if (a.stats && b.stats) {
          comparison = a.stats.rate7d - b.stats.rate7d;
          if (comparison === 0) {
            // Tie-break: the patient silent for longer sorts first when ascending.
            comparison = (b.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER)
              - (a.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER);
          }
        }
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    // Attention-first: flagged rows lead, each group keeping the sort above.
    return attentionFirst ? pinFlaggedFirst(result, (row) => row.attentionFlagged) : result;
  }, [unifiedRows, search, conditions, today, sortField, sortOrder, attentionFirst]);

  const pinnedCount = attentionFirst ? filteredAndSortedPatients.filter((row) => row.attentionFlagged).length : 0;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSort({ field, order: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      // Logging defaults to ascending so the least-engaged patients surface first.
      setSort({ field, order: field === 'logging' ? 'asc' : 'desc' });
    }
  };

  return (
    <div className="mx-auto max-w-[1560px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] font-bold leading-none tracking-tight text-navy">Patient Roster</h1>
          <p className="mt-2 text-sm text-muted-foreground">Manage and monitor all THINNR protocol participants.</p>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
          <OfficeGetTheAppPanel liveEnabled={liveEnabled} liveOffice={liveOffice} />
          {liveEnabled && <InvitePatientAction office={liveOffice} />}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-b border-border p-4 bg-paper-alt">
          <div className="relative w-full sm:w-80">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="patient-search" className="sr-only">Search patients by name, email, or phone</label>
            <input
              id="patient-search"
              data-testid="input-patient-search"
              type="text"
              placeholder="Search patients..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-card pl-9 pr-3 text-xs text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
            {attentionFirst && (
              <button
                type="button"
                onClick={clearAttentionFirst}
                data-testid="button-clear-attention-first"
                aria-label={`Attention first: ${pinnedCount} flagged patient${pinnedCount === 1 ? '' : 's'} pinned to the top. Turn off`}
                title="Flagged patients are pinned to the top. Click to return to the normal order."
                className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#e8b47c] bg-[#fff4e6] px-2.5 text-xs font-semibold text-[#b65c22] shadow-xs transition-colors hover:bg-[#ffe9d1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                Attention first
                <span className="rounded-sm bg-white/70 px-1 font-mono text-[10px]" aria-hidden="true">{pinnedCount}</span>
                <X size={12} aria-hidden="true" />
              </button>
            )}
            <RosterFilterButton
              applied={conditions}
              onApply={setConditions}
              programOptions={programOptions}
              onSaveQuickSet={saveQuickSet}
              matchCount={filteredAndSortedPatients.length}
            />
            <RosterSortSelect sort={view.sort} onChange={setSort} className="md:hidden" />
          </div>
        </div>

        <RosterQuickSets sets={quickSets} activeId={currentQuickSet?.id ?? null} onSelect={applyQuickSet} onRemove={removeQuickSet} />
        <RosterFilterChips
          conditions={conditions}
          programOptions={programOptions}
          onRemove={(index) => setConditions(conditions.filter((_, i) => i !== index))}
          onClearAll={() => setConditions([])}
        />

        <div className="divide-y divide-border md:hidden">
          {filteredAndSortedPatients.map((patient) => {
            return (
              <Link
                key={patient.id}
                href={`/patients/${patient.id}`}
                className="block p-4 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-[10px] font-bold text-primary">{patient.initials}</span>
                    <div className="min-w-0">
                      <span className="flex items-center gap-2">
                        <b className="block truncate font-serif text-[15px] font-semibold leading-tight text-navy">{patient.name}</b>
                        {patient.outreachChip && <NudgeChip outreach={patient.outreachChip} />}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{patient.providerName}</span>
                    </div>
                  </div>
                  <StatusCell patient={patient} office={liveOffice} align="right" />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Stage</p>
                    <p className="mt-1 text-foreground/80">{patient.stageDisplay}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Started</p>
                    <p className="mt-1 text-foreground/80">{patient.startDateDisplay}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Progress</p>
                    <p className="mt-1 font-mono font-semibold text-navy">{patient.weightLossDisplay}</p>
                    <p className="text-[9px] text-muted-foreground">{patient.percentLossDisplay}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                  <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Logging (7d)</p>
                  {patient.activity ? <LiveLoggingCell activity={patient.activity} align="right" /> : patient.stats && <LoggingSignal stats={patient.stats} align="right" />}
                </div>
                {patient.activity && (
                  <div className="mt-3 flex items-start justify-between gap-3 border-t border-border/60 pt-3">
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Check-ins</p>
                    <LiveEngagementCell activity={patient.activity} align="right" />
                  </div>
                )}
                {patient.showResend && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      data-testid={`button-resend-invite-${patient.id}`}
                      className={`${BTN_SECONDARY} h-8 px-3`}
                      disabled={resending === patient.id}
                      onClick={(e) => {
                        e.preventDefault();
                        void resend(patient.rawLive!);
                      }}
                    >
                      {resending === patient.id ? 'Resending…' : 'Resend invite'}
                    </button>
                  </div>
                )}
                {patient.isLive && !liveOffice && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} h-8 px-3`}
                      data-testid={`button-message-patient-${patient.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(`/conversations?startPatient=${encodeURIComponent(patient.id)}`);
                      }}
                    >
                      Message Care Team
                    </button>
                  </div>
                )}
              </Link>
            );
          })}
          {liveEnabled && liveRosterIsLoading && (
            <div className="p-10 text-center text-xs text-muted-foreground">Loading patients…</div>
          )}
          {liveEnabled && liveRosterIsError && (
            <div className="p-10 text-center text-xs text-destructive" role="alert">
              {liveRosterError instanceof Error ? liveRosterError.message : 'The roster could not be loaded.'}
            </div>
          )}
          {(!liveEnabled || liveRosterData) && filteredAndSortedPatients.length === 0 && (
            <div className="p-10 text-center text-xs text-muted-foreground">No patients found matching your search. Search by name, email, or phone.</div>
          )}
        </div>

        {/* Table */}
        <div className="hidden overflow-x-auto md:block">
          <table className={`w-full table-fixed text-left text-xs ${liveEnabled ? "min-w-[1040px]" : "min-w-[840px]"}`}>
            <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground">
              <tr>
                <th className={`${liveEnabled ? "w-[21%]" : "w-[34%]"} px-3 py-3 font-semibold`}>
                  <button onClick={() => handleSort('name')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Patient {sortField === 'name' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className="w-[10.5rem] whitespace-nowrap px-3 py-3 font-semibold">
                  <button onClick={() => handleSort('status')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Status {sortField === 'status' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className="w-[7.5rem] whitespace-nowrap px-3 py-3 font-semibold">
                  <button onClick={() => handleSort('startDate')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Start Date {sortField === 'startDate' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className={`${liveEnabled ? "w-[7.75rem]" : ""} whitespace-nowrap px-3 py-3 font-semibold`}>
                  <button onClick={() => handleSort('logging')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Logging (7d) {sortField === 'logging' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                {liveEnabled && <th className="whitespace-nowrap px-3 py-3 font-semibold">Check-ins &amp; wellbeing</th>}
                {liveEnabled && <th className="w-[3.75rem] px-3 py-3 font-semibold">Meds</th>}
                <th className="w-[6rem] whitespace-nowrap px-3 py-3 font-semibold text-right">
                  <button onClick={() => handleSort('weightLoss')} className="flex items-center justify-end gap-1 w-full rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Weight Loss {sortField === 'weightLoss' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className={`${liveEnabled ? "w-[8.25rem]" : "w-12"} px-3 py-3 font-semibold`}></th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedPatients.map((patient) => {
                return (
                  <tr
                    key={patient.id}
                    tabIndex={0}
                    aria-label={`Open ${patient.name}’s patient record`}
                    onClick={(event) => {
                      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      if ((event.target as Element).closest('a, button, input, select, textarea')) return;
                      if (window.getSelection()?.toString()) return;
                      navigate(`/patients/${patient.id}`);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      navigate(`/patients/${patient.id}`);
                    }}
                    className="group cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-[10px] font-bold text-primary">
                          {patient.initials}
                        </span>
                        <div className="min-w-0">
                          <span className="flex items-center gap-2">
                            <b className="block font-serif text-sm font-semibold leading-tight text-navy">{patient.name}</b>
                            {patient.outreachChip && <NudgeChip outreach={patient.outreachChip} />}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground" title={patient.email ?? undefined}>
                            {patient.email}
                            {patient.providerName !== '—' && <span> · {patient.providerName}</span>}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <StatusCell patient={patient} office={liveOffice} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-foreground/80">
                      <span className="block">{patient.startDateDisplay}</span>
                      {patient.stageDisplay !== '—' && <span className="block text-[10px] capitalize text-muted-foreground">{patient.stageDisplay}</span>}
                    </td>
                    <td className="px-3 py-3">
                      {patient.activity ? <LiveLoggingCell activity={patient.activity} /> : patient.stats && <LoggingSignal stats={patient.stats} />}
                    </td>
                    {liveEnabled && (
                      <td className="px-3 py-3">
                        {patient.activity && <LiveEngagementCell activity={patient.activity} />}
                      </td>
                    )}
                    {liveEnabled && (
                      <td
                        className="px-3 py-3 font-mono font-semibold text-navy"
                        data-testid={`medication-adherence-${patient.id}`}
                        title={patient.medicationAdherence ? `${patient.medicationAdherence.taken}/${patient.medicationAdherence.due} in 30 days` : undefined}
                      >
                        {patient.medicationAdherence?.rate == null ? '—' : `${patient.medicationAdherence.rate}%`}
                      </td>
                    )}
                    <td className="px-3 py-3 text-right">
                      <b className="block font-mono font-semibold text-navy">{patient.weightLossDisplay}</b>
                      <span className="text-[10px] text-muted-foreground">{patient.percentLossDisplay}</span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {patient.showResend ? (
                        <button
                          type="button"
                          data-testid={`button-resend-invite-${patient.id}`}
                          className={`${BTN_SECONDARY} h-8 whitespace-nowrap px-2.5`}
                          disabled={resending === patient.id}
                          onClick={(e) => {
                            e.preventDefault();
                            void resend(patient.rawLive!);
                          }}
                        >
                          {resending === patient.id ? 'Resending…' : 'Resend invite'}
                        </button>
                      ) : (
                        <Link
                          href={`/patients/${patient.id}`}
                          aria-label={`Open ${patient.name}’s patient record`}
                          tabIndex={-1}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}

              {liveEnabled && liveRosterIsLoading && (
                <tr>
                  <td colSpan={liveEnabled ? 7 : 6} className="px-4 py-12 text-center text-muted-foreground">
                    Loading patients…
                  </td>
                </tr>
              )}
              {liveEnabled && liveRosterIsError && (
                <tr>
                  <td colSpan={liveEnabled ? 7 : 6} className="px-4 py-12 text-center text-destructive">
                    {liveRosterError instanceof Error ? liveRosterError.message : 'The roster could not be loaded.'}
                  </td>
                </tr>
              )}
              {(!liveEnabled || liveRosterData) && filteredAndSortedPatients.length === 0 && (
                <tr>
                  <td colSpan={liveEnabled ? 7 : 6} className="px-4 py-12 text-center text-muted-foreground">
                    No patients found matching your search. Search by name, email, or phone.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination mock — the roster is a lifetime view, untouched by the header date range */}
        <div className="border-t border-border px-4 py-3 flex items-center justify-between text-xs text-muted-foreground bg-paper-alt">
          <span>Showing <b className="font-semibold text-foreground">{filteredAndSortedPatients.length}</b> lifetime records</span>
          <div className="flex gap-2">
            <button className="rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled>Prev</button>
            <button className="rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled>Next</button>
          </div>
        </div>
      </div>

      {liveEnabled && liveRosterData?.deletedAccounts && (
        <DeletedAccountsSection accounts={liveRosterData.deletedAccounts} />
      )}
    </div>
  );
}
