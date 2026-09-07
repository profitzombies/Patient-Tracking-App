import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { Search, Filter, ArrowUpDown, ChevronRight } from "lucide-react";
import { useScopedPatients, useScopedProviders } from "@/data/scoped-data";
import { LAPSED_AFTER_DAYS, getLoggingStats, isLapsed, lastLogLabel, type LoggingStats } from "@/data/nutrition-data";
import { getNudgeAssessment } from "@/data/stall-nudge";
import { usePatientSession } from "@/contexts/patient-session";
import { useLiveRoster } from "@/hooks/use-live-roster";
import { InvitePatientAction, InvitationChip, officeRosterQueryKey } from "@/components/office/LiveRoster";
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

type SortField = 'name' | 'startDate' | 'status' | 'weightLoss' | 'logging';
type SortOrder = 'asc' | 'desc';
type LoggingFilter = 'all' | 'lapsed';

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
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${tone}`} title={status === 'unknown' ? 'Activity signals did not load for this patient' : undefined}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {displayStatus}
    </span>
  );
}

function FollowUpAction({ patientId, reason, currentStatus, office }: {
  patientId: string;
  reason: PatientOperationalFollowUpReason;
  currentStatus: 'open' | 'resolved';
  office: string | null;
}) {
  const updateFollowUp = useUpdateOfficePatientFollowUp();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isResolved = currentStatus === 'resolved';

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
      onClick={toggle}
      disabled={updateFollowUp.isPending}
      aria-label={`${isResolved ? 'Reopen' : 'Mark'} ${reason.replaceAll('_', ' ')} ${isResolved ? 'follow-up' : 'reviewed'}`}
      title={`${isResolved ? 'Reopen' : 'Mark'} ${reason.replaceAll('_', ' ')} ${isResolved ? 'follow-up' : 'reviewed'}`}
      className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm border transition-colors ${
        isResolved ? 'bg-secondary text-muted-foreground border-border hover:bg-muted' : 'bg-primary text-primary-foreground border-primary hover:bg-navy'
      }`}
    >
      {updateFollowUp.isPending ? 'Saving...' : (isResolved ? 'Reopen' : 'Review')}
    </button>
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
  // Live invitations only exist for authenticated scopes: a signed-in
  // provider office (server derives the office from the bearer token) or an
  // HQ drill-in on an explicitly scoped account. Demo personas never call
  // the live endpoints, so the seeded demo stays untouched.
  const { data: liveRosterData, isLoading: liveRosterIsLoading, isError: liveRosterIsError, error: liveRosterError, liveEnabled, liveOffice } = useLiveRoster();
  // Base-aware navigate: resolves against the mount point exactly like the
  // roster's <Link>s, so row clicks stay inside the HQ drill-in scope too.
  const [, navigate] = useLocation();
  const searchParams = useSearch();
  const urlParams = new URLSearchParams(searchParams);
  const arrivedLapsed = urlParams.get('logging') === 'lapsed';
  const arrivedStatus = urlParams.get('status');
  const arrivedReason = urlParams.get('reason');

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(arrivedStatus || 'all');
  const [loggingFilter, setLoggingFilter] = useState<LoggingFilter>(arrivedLapsed ? 'lapsed' : 'all');
  const [reasonFilter, setReasonFilter] = useState<string>(arrivedReason || 'all');
  const [sortField, setSortField] = useState<SortField>(arrivedLapsed ? 'logging' : 'startDate');
  const [sortOrder, setSortOrder] = useState<SortOrder>(arrivedLapsed ? 'asc' : 'desc');
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

  // Landing here from the overview compliance card pre-applies the lapsed view.
  useEffect(() => {
    if (arrivedLapsed) {
      setLoggingFilter('lapsed');
      setSortField('logging');
      setSortOrder('asc');
    }
    if (arrivedStatus) {
      setStatusFilter(arrivedStatus);
    }
    if (arrivedReason) {
      setReasonFilter(arrivedReason);
      setStatusFilter('all');
      setLoggingFilter('all');
    }
  }, [arrivedLapsed, arrivedStatus, arrivedReason]);

  const statsById = useMemo(
    () => new Map(patients.map((patient) => [patient.id, getLoggingStats(patient)])),
    [patients],
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

        return {
          id: p.id,
          name: p.name,
          initials,
          email: p.email,
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
      return {
        id: p.id,
        name: p.name,
        initials: p.initials,
        email: p.email,
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
        outreachChip: getNudgeAssessment(p).active ? DEMO_ELIGIBLE_OUTREACH : null,
        isLive: false as boolean,
        showResend: false,
        rawLive: undefined
      };
    });
  }, [liveEnabled, liveRosterData, patients, providers, getCurrentWeight, statsById]);

  const filteredAndSortedPatients = useMemo(() => {
    let result = unifiedRows.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
                            (p.email ?? '').toLowerCase().includes(search.toLowerCase());
      // Live rosters carry an operational status (on_track / needs_attention /
      // inactive / invited / paused / discharged); "active" there means an
      // activated account, the same definition the office-analytics rollups
      // use for their Active figure, so drill-ins from those numbers land on
      // the matching list. Paused and discharged records are not activated.
      const matchesStatus =
        statusFilter === 'all' ||
        p.status === statusFilter ||
        (statusFilter === 'active' && p.isLive && p.status !== 'invited' && p.status !== 'paused' && p.status !== 'discharged');
      // Live rows use the server's own lapsed verdict; rows whose activity
      // did not load are never "lapsed". Demo rows keep the seeded stats.
      const matchesLogging = loggingFilter === 'all'
        || (p.activity ? isLiveLapsed(p.activity) : p.stats ? isLapsed(p.stats) : false);

      let matchesReason = true;
      if (reasonFilter !== 'all') {
        if (p.isLive && p.rawLive?.operational?.reasons) {
          matchesReason = p.rawLive.operational.reasons.includes(reasonFilter as any);
        } else {
          matchesReason = false;
        }
      }

      return matchesSearch && matchesStatus && matchesLogging && matchesReason;
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

    return result;
  }, [unifiedRows, search, statusFilter, loggingFilter, reasonFilter, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      // Logging defaults to ascending so the least-engaged patients surface first.
      setSortOrder(field === 'logging' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] font-bold leading-none tracking-tight text-navy">Patient Roster</h1>
          <p className="mt-2 text-sm text-muted-foreground">Manage and monitor all THINNR protocol participants.</p>
        </div>
        {liveEnabled && <InvitePatientAction office={liveOffice} />}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-b border-border p-4 bg-paper-alt">
          <div className="relative w-full sm:w-80">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="patient-search" className="sr-only">Search patients by name or email</label>
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
            <div className="flex items-center text-xs font-semibold text-muted-foreground">
              <Filter size={14} className="mr-1.5" /> Filter:
            </div>
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border border-border bg-card px-2 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Patients</option>
              {liveEnabled ? (
                <>
                  <option value="active">Active (activated)</option>
                  <option value="on_track">On Track</option>
                  <option value="needs_attention">Needs Attention</option>
                  <option value="inactive">Inactive</option>
                  <option value="paused">Paused</option>
                  <option value="discharged">Discharged</option>
                  <option value="invited">Invited</option>
                  <option value="unknown">Activity unknown</option>
                </>
              ) : (
                <>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="overdue">Overdue</option>
                  <option value="graduated">Graduated (Maintenance)</option>
                </>
              )}
            </select>
            <select
              aria-label="Filter by companion-app logging"
              value={loggingFilter}
              onChange={(e) => setLoggingFilter(e.target.value as LoggingFilter)}
              className="h-9 rounded-md border border-border bg-card px-2 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All logging</option>
              <option value="lapsed">Lapsed {LAPSED_AFTER_DAYS}+ days</option>
            </select>
            {liveEnabled && (
              <select
                aria-label="Filter by watchlist reason"
                value={reasonFilter}
                onChange={(e) => setReasonFilter(e.target.value)}
                className="h-9 rounded-md border border-border bg-card px-2 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="all">All Risk Reasons</option>
                <option value="check_in_overdue">Check-in Overdue</option>
                <option value="logging_lapsed">Logging Lapsed</option>
                <option value="no_activity_14d">Inactive (14d)</option>
              </select>
            )}
            <select
              aria-label="Sort patients"
              value={`${sortField}-${sortOrder}`}
              onChange={(event) => {
                const [field, order] = event.target.value.split('-') as [SortField, SortOrder];
                setSortField(field);
                setSortOrder(order);
              }}
              className="h-9 rounded-md border border-border bg-card px-2 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring md:hidden"
            >
              <option value="startDate-desc">Newest start</option>
              <option value="name-asc">Name A–Z</option>
              <option value="weightLoss-desc">Most weight lost</option>
              <option value="logging-asc">Lowest logging rate</option>
              <option value="status-asc">Status</option>
            </select>
          </div>
        </div>

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
                  <div className="flex flex-col items-end gap-1.5">
                    {patient.isLive && patient.rawLive?.invitation && <InvitationChip patient={patient.rawLive} />}
                    {!patient.showResend && <StatusChip status={patient.status} />}
                    {patient.rawLive?.deletion && <DeletionChip deletion={patient.rawLive.deletion} testId={`chip-deletion-${patient.id}`} />}

                    {patient.isLive && patient.rawLive?.operational?.reasons.map((reason) => {
                      const followUp = patient.rawLive?.operational?.followUps?.find((item) => item.reason === reason);
                      const status = followUp?.status ?? 'open';
                      const displayReason = reason === 'check_in_overdue' ? 'Overdue' :
                                            reason === 'logging_lapsed' ? 'Lapsed' :
                                            'Inactive';
                      return (
                        <div key={reason} className="mt-0.5 flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                          <span className="text-[9px] text-warn font-semibold uppercase tracking-wider">{displayReason}</span>
                          <FollowUpAction patientId={patient.id} reason={reason} currentStatus={status} office={liveOffice} />
                        </div>
                      );
                    })}
                  </div>
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
            <div className="p-10 text-center text-xs text-muted-foreground">No patients found matching your search.</div>
          )}
        </div>

        {/* Table */}
        <div className="hidden overflow-x-auto md:block">
          <table className={`w-full text-left text-xs ${liveEnabled ? "min-w-[1180px]" : "min-w-[920px]"}`}>
            <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold w-1/4">
                  <button onClick={() => handleSort('name')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Patient {sortField === 'name' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">
                  <button onClick={() => handleSort('status')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Status {sortField === 'status' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">Stage</th>
                <th className="px-4 py-3 font-semibold">Provider</th>
                <th className="px-4 py-3 font-semibold">
                  <button onClick={() => handleSort('startDate')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Start Date {sortField === 'startDate' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">
                  <button onClick={() => handleSort('logging')} className="flex items-center gap-1 rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Logging (7d) {sortField === 'logging' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                {liveEnabled && <th className="px-4 py-3 font-semibold">Check-ins &amp; wellbeing</th>}
                <th className="px-4 py-3 font-semibold text-right">
                  <button onClick={() => handleSort('weightLoss')} className="flex items-center justify-end gap-1 w-full rounded-sm transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Weight Loss {sortField === 'weightLoss' && <ArrowUpDown size={12} className="text-primary" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold w-12"></th>
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
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-[10px] font-bold text-primary">
                          {patient.initials}
                        </span>
                        <div>
                          <span className="flex items-center gap-2">
                            <b className="block font-serif text-sm font-semibold leading-tight text-navy">{patient.name}</b>
                            {patient.outreachChip && <NudgeChip outreach={patient.outreachChip} />}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{patient.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        {patient.isLive && patient.rawLive?.invitation && <InvitationChip patient={patient.rawLive} />}
                        {!patient.showResend && <StatusChip status={patient.status} />}
                        {patient.rawLive?.deletion && <DeletionChip deletion={patient.rawLive.deletion} testId={`chip-deletion-${patient.id}`} />}

                        {patient.isLive && patient.rawLive?.operational?.reasons.map((reason) => {
                          const followUp = patient.rawLive?.operational?.followUps?.find((item) => item.reason === reason);
                          const status = followUp?.status ?? 'open';
                          const displayReason = reason === 'check_in_overdue' ? 'Overdue' :
                                                reason === 'logging_lapsed' ? 'Lapsed' :
                                                'Inactive';
                          return (
                            <div key={reason} className="mt-1 flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                              <span className="text-[9px] text-warn font-semibold uppercase tracking-wider">{displayReason}</span>
                              <FollowUpAction patientId={patient.id} reason={reason} currentStatus={status} office={liveOffice} />
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-foreground/80 capitalize">
                        {patient.stageDisplay}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-foreground/80">
                      {patient.providerName}
                    </td>
                    <td className="px-4 py-3 text-foreground/80">
                      {patient.startDateDisplay}
                    </td>
                    <td className="px-4 py-3">
                      {patient.activity ? <LiveLoggingCell activity={patient.activity} /> : patient.stats && <LoggingSignal stats={patient.stats} />}
                    </td>
                    {liveEnabled && (
                      <td className="px-4 py-3 min-w-[240px]">
                        {patient.activity && <LiveEngagementCell activity={patient.activity} />}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <b className="block font-mono font-semibold text-navy">{patient.weightLossDisplay}</b>
                      <span className="text-[10px] text-muted-foreground">{patient.percentLossDisplay}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {patient.showResend ? (
                        <button
                          type="button"
                          data-testid={`button-resend-invite-${patient.id}`}
                          className={`${BTN_SECONDARY} h-8 px-3 whitespace-nowrap`}
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
                  <td colSpan={liveEnabled ? 9 : 8} className="px-4 py-12 text-center text-muted-foreground">
                    Loading patients…
                  </td>
                </tr>
              )}
              {liveEnabled && liveRosterIsError && (
                <tr>
                  <td colSpan={liveEnabled ? 9 : 8} className="px-4 py-12 text-center text-destructive">
                    {liveRosterError instanceof Error ? liveRosterError.message : 'The roster could not be loaded.'}
                  </td>
                </tr>
              )}
              {(!liveEnabled || liveRosterData) && filteredAndSortedPatients.length === 0 && (
                <tr>
                  <td colSpan={liveEnabled ? 9 : 8} className="px-4 py-12 text-center text-muted-foreground">
                    No patients found matching your search.
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
