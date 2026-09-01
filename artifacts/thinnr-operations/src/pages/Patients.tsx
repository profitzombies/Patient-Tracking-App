import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { Search, Filter, ArrowUpDown, ChevronRight, MailWarning, MessageCircleHeart } from "lucide-react";
import { type Status } from "@/data/mock-data";
import { useScopedPatients, useScopedProviders } from "@/data/scoped-data";
import { LAPSED_AFTER_DAYS, getLoggingStats, isLapsed, lastLogLabel, type LoggingStats } from "@/data/nutrition-data";
import { getNudgeAssessment } from "@/data/stall-nudge";
import { usePatientSession } from "@/contexts/patient-session";
import { useProviderScope } from "@/contexts/provider-scope";
import { useSession } from "@/contexts/session";
import { InvitePatientAction, InvitationChip, officeRosterQueryKey } from "@/components/office/LiveRoster";
import { BTN_SECONDARY } from "@/components/patient/heritage";
import { fetchOfficeRoster, resendInvitation, type OfficePatient } from "@/lib/office-roster";
import { useToast } from "@/hooks/use-toast";

type SortField = 'name' | 'startDate' | 'status' | 'weightLoss' | 'logging';
type SortOrder = 'asc' | 'desc';
type LoggingFilter = 'all' | 'lapsed';

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Heritage status tints — mirrors the mobile StatusBadge (thinnr-mobile
// constants/colors.ts): healthy stays in the cobalt family, watch and risk
// use the shared warm/risk tints that have no semantic token equivalents.
function StatusChip({ status }: { status: Status }) {
  const tone = status === 'active' || status === 'graduated'
    ? 'border-accent-border bg-accent text-primary'
    : status === 'paused'
      ? 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]'
      : 'border-[#d5a7a7] bg-[#fff0f0] text-destructive';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${tone}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

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
 * itself sends automatically in the patient's app with no approval step,
 * and delivery/engagement/opt-out state lives there — this surface never
 * claims a conversation was sent. The detail page carries the signals.
 */
function NudgeChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] text-[#b65c22]">
      <MessageCircleHeart size={10} aria-hidden="true" />
      Outreach due
    </span>
  );
}

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
  const { authStatus, authRole } = useSession();
  const scope = useProviderScope();
  const liveEnabled =
    authStatus === 'signed-in' &&
    (authRole === 'provider_staff' || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
  const liveOffice = authRole === 'hq_admin' ? scope?.providerId ?? null : null;
  // Base-aware navigate: resolves against the mount point exactly like the
  // roster's <Link>s, so row clicks stay inside the HQ drill-in scope too.
  const [, navigate] = useLocation();
  const searchParams = useSearch();
  const arrivedLapsed = new URLSearchParams(searchParams).get('logging') === 'lapsed';
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [loggingFilter, setLoggingFilter] = useState<LoggingFilter>(arrivedLapsed ? 'lapsed' : 'all');
  const [sortField, setSortField] = useState<SortField>(arrivedLapsed ? 'logging' : 'startDate');
  const [sortOrder, setSortOrder] = useState<SortOrder>(arrivedLapsed ? 'asc' : 'desc');
  const [resending, setResending] = useState<string | null>(null);
  const liveRoster = useQuery({
    queryKey: officeRosterQueryKey(liveOffice),
    queryFn: () => fetchOfficeRoster(liveOffice),
    enabled: liveEnabled,
    refetchInterval: liveEnabled ? 30_000 : false,
  });

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
  }, [arrivedLapsed]);

  const statsById = useMemo(
    () => new Map(patients.map((patient) => [patient.id, getLoggingStats(patient)])),
    [patients],
  );

  const filteredAndSortedPatients = useMemo(() => {
    let result = patients.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || 
                            p.email.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
      const stats = statsById.get(p.id);
      const matchesLogging = loggingFilter === 'all' || (stats ? isLapsed(stats) : false);
      return matchesSearch && matchesStatus && matchesLogging;
    });

    result.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'startDate') {
        comparison = new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
      } else if (sortField === 'status') {
        comparison = a.status.localeCompare(b.status);
      } else if (sortField === 'weightLoss') {
        const aLoss = a.startingWeight - getCurrentWeight(a);
        const bLoss = b.startingWeight - getCurrentWeight(b);
        comparison = aLoss - bLoss;
      } else if (sortField === 'logging') {
        const aStats = statsById.get(a.id);
        const bStats = statsById.get(b.id);
        comparison = (aStats?.rate7d ?? 0) - (bStats?.rate7d ?? 0);
        if (comparison === 0) {
          // Tie-break: the patient silent for longer sorts first when ascending.
          comparison = (bStats?.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER)
            - (aStats?.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER);
        }
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [patients, search, statusFilter, loggingFilter, sortField, sortOrder, getCurrentWeight, statsById]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      // Logging defaults to ascending so the least-engaged patients surface first.
      setSortOrder(field === 'logging' ? 'asc' : 'desc');
    }
  };

  if (liveEnabled) {
    const livePatients = [...(liveRoster.data?.patients ?? [])]
      .filter((patient) => {
        const needle = search.trim().toLowerCase();
        return !needle || patient.name.toLowerCase().includes(needle) || (patient.email ?? '').toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        if (sortField === 'name') return (sortOrder === 'asc' ? 1 : -1) * a.name.localeCompare(b.name);
        const aDate = a.startDate ?? a.program?.startDate ?? a.createdAt ?? '';
        const bDate = b.startDate ?? b.program?.startDate ?? b.createdAt ?? '';
        return (sortOrder === 'asc' ? 1 : -1) * aDate.localeCompare(bDate);
      });
    return (
      <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
        <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <h1 className="font-serif text-[32px] font-bold leading-none tracking-tight text-navy">Patient Roster</h1>
            <p className="mt-2 text-sm text-muted-foreground">Manage and monitor all THINNR protocol participants.</p>
          </div>
          <InvitePatientAction office={liveOffice} />
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft" data-testid="live-roster">
          <div className="border-b border-border bg-paper-alt p-4">
            <div className="relative w-full sm:w-80">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <label htmlFor="patient-search" className="sr-only">Search patients by name or email</label>
              <input id="patient-search" data-testid="input-patient-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patients..." className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-xs outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>
          {liveRoster.isLoading && <div className="p-10 text-center text-xs text-muted-foreground">Loading patients…</div>}
          {liveRoster.isError && <div className="p-10 text-center text-xs text-destructive" role="alert">{liveRoster.error instanceof Error ? liveRoster.error.message : 'The roster could not be loaded.'}</div>}
          {liveRoster.data && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-left text-xs">
                <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground"><tr>
                  <th className="px-4 py-3"><button data-testid="button-sort-live-name" onClick={() => handleSort('name')}>Patient</button></th>
                  <th className="px-4 py-3">Status</th><th className="px-4 py-3">Program</th><th className="px-4 py-3">Provider</th><th className="px-4 py-3">Started</th><th className="px-4 py-3">Invitation email</th><th className="px-4 py-3 text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {livePatients.map((patient) => (
                    <tr key={patient.id} tabIndex={0} data-testid={`live-roster-row-${patient.id}`} onClick={(event) => { if (!(event.target as Element).closest('button,a')) navigate(`/patients/${patient.id}`); }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); navigate(`/patients/${patient.id}`); } }} className="cursor-pointer border-b border-border transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                      <td className="px-4 py-3"><b className="block font-serif text-sm text-navy">{patient.name}</b><span className="text-[10px] text-muted-foreground">{patient.email ?? 'No email on file'}</span></td>
                      <td className="px-4 py-3">{patient.invitation ? <InvitationChip patient={patient} /> : <span className="capitalize text-foreground/80">{patient.activationStatus ?? patient.status ?? '—'}</span>}</td>
                      <td className="px-4 py-3 text-foreground/80">{patient.stage ? (patient.stage === 'protocol' && patient.protocolWeek ? `Week ${patient.protocolWeek}` : patient.stage) : patient.program?.id ? 'Enrolled' : '—'}</td>
                      <td className="px-4 py-3 text-foreground/80">{patient.providerName ?? '—'}</td>
                      <td className="px-4 py-3 text-foreground/80">{patient.startDate ?? patient.program?.startDate ?? patient.createdAt ? formatDate(patient.startDate ?? patient.program?.startDate ?? patient.createdAt!) : '—'}</td>
                      <td className="px-4 py-3">{patient.invitation?.emailStatus === 'failed' ? <span className="inline-flex items-center gap-1 font-semibold text-destructive"><MailWarning size={12} />Delivery failed</span> : <span className="capitalize text-muted-foreground">{patient.invitation?.emailStatus ?? '—'}</span>}</td>
                      <td className="px-4 py-3 text-right">{patient.invitation?.state === 'pending' && <button type="button" data-testid={`button-resend-invite-${patient.id}`} className={`${BTN_SECONDARY} h-8 px-3`} disabled={resending === patient.id} onClick={() => void resend(patient)}>{resending === patient.id ? 'Resending…' : 'Resend invite'}</button>}</td>
                    </tr>
                  ))}
                  {livePatients.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">{search ? 'No patients found matching your search.' : 'No patients yet. Use Invite Patient to add the first one.'}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-border bg-paper-alt px-4 py-3 text-xs text-muted-foreground">Showing <b className="text-foreground">{livePatients.length}</b> records</div>
        </div>
      </div>
    );
  }

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
              onChange={(e) => setStatusFilter(e.target.value as Status | 'all')}
              className="h-9 rounded-md border border-border bg-card px-2 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Patients</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="overdue">Overdue</option>
              <option value="graduated">Graduated (Maintenance)</option>
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
            const provider = providers.find((candidate) => candidate.id === patient.providerId);
            const weightLoss = patient.startingWeight - getCurrentWeight(patient);
            const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
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
                        {getNudgeAssessment(patient).active && <NudgeChip />}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{provider?.name}</span>
                    </div>
                  </div>
                  <StatusChip status={patient.status} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Stage</p>
                    <p className="mt-1 text-foreground/80">{patient.stage === 'protocol' ? `Week ${patient.protocolWeek}` : 'Maintenance'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Started</p>
                    <p className="mt-1 text-foreground/80">{new Date(patient.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Progress</p>
                    <p className="mt-1 font-mono font-semibold text-navy">{weightLoss.toFixed(1)} lbs</p>
                    <p className="text-[9px] text-muted-foreground">{percentLoss}%</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                  <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Logging (7d)</p>
                  <LoggingSignal stats={statsById.get(patient.id)!} align="right" />
                </div>
              </Link>
            );
          })}
          {filteredAndSortedPatients.length === 0 && (
            <div className="p-10 text-center text-xs text-muted-foreground">No patients found matching your criteria.</div>
          )}
        </div>

        {/* Table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-xs min-w-[920px]">
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
                const provider = providers.find(p => p.id === patient.providerId);
                const weightLoss = patient.startingWeight - getCurrentWeight(patient);
                const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
                
                return (
                  <tr
                    key={patient.id}
                    tabIndex={0}
                    aria-label={`Open ${patient.name}’s patient record`}
                    onClick={(event) => {
                      // Row navigation is a convenience layer over the real
                      // profile links: leave nested controls (the trailing
                      // arrow), text selection, and modified clicks alone.
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
                            {getNudgeAssessment(patient).active && <NudgeChip />}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{patient.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip status={patient.status} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-foreground/80 capitalize">
                        {patient.stage === 'protocol' ? `Week ${patient.protocolWeek}` : 'Maintenance'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-foreground/80">
                      {provider?.name.split(',')[0]}
                    </td>
                    <td className="px-4 py-3 text-foreground/80">
                      {new Date(patient.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <LoggingSignal stats={statsById.get(patient.id)!} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <b className="block font-mono font-semibold text-navy">{weightLoss.toFixed(1)} lbs</b>
                      <span className="text-[10px] text-muted-foreground">{percentLoss}%</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Still a real link (new-tab, context menu, assistive
                          tech), but out of the tab order — the focusable row
                          is the single keyboard stop, so no duplicate stops
                          or double navigation. */}
                      <Link
                        href={`/patients/${patient.id}`}
                        aria-label={`Open ${patient.name}’s patient record`}
                        tabIndex={-1}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronRight size={16} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
              
              {filteredAndSortedPatients.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                    No patients found matching your criteria.
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
    </div>
  );
}
