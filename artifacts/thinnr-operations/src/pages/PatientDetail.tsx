import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Edit2,
  FileText,
  Mail,
  PackageOpen,
  Phone,
  Target,
  Truck,
  Droplets,
} from "lucide-react";
import { MOCK_PRODUCTS, type ActivityItem } from "@/data/mock-data";
import { useScopedPatients, useScopedProviders, useScopedSubscriptions } from "@/data/scoped-data";
import { TODAY_KEY } from "@/data/nutrition-data";
import { ADHERENCE_WINDOW_DAYS, NUDGE_COOLDOWN_DAYS, getNudgeAssessment } from "@/data/stall-nudge";
import { WeightTrend } from "@/components/patient/WeightTrend";
import { BodyMeasurementsCard } from "@/components/patient/BodyMeasurements";
import { LiveBodyMeasurements } from "@/components/office/LiveBodyMeasurements";
import { LiveMedications } from "@/components/office/LiveMedications";
import { DeletedRecordNotice, DeletionBanner } from "@/components/office/AccountDeletion";
import type { MeasurementVisit } from "@/lib/body-measurements";
import { NutritionLifestyle } from "@/components/patient/NutritionLifestyle";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  CHIP_RISK,
  CHIP_WARM,
  INPUT_CLASS,
  LINK_ACTION,
  MICRO_LABEL,
  PANEL_LABEL,
  SectionCard,
} from "@/components/patient/heritage";
import { usePatientSession } from "@/contexts/patient-session";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/contexts/session";
import { useProviderScope } from "@/contexts/provider-scope";
import { PatientBloodwork } from "@/components/bloodwork/PatientBloodwork";
import {
  fetchOfficePatient,
  fetchOfficePatientNotifications,
  OfficeRosterError,
  type OfficeDiaryEntry,
  type OfficePatientDetail,
} from "@/lib/office-roster";
import { useStartOfficeConversation } from "@workspace/api-client-react";
import {
  fetchPatientSessions,
  signOutPatientSessions,
  type SecurityReason,
} from "@/lib/office-api";
import { EngagementSummary } from "@/components/office/RosterActivity";
import { CoachOutreachTimeline } from "@/components/office/NotificationTimeline";
import {
  EditPatientProfile,
  PatientStatusControl,
  ProviderNotes,
  StaffWeightActions,
  StaffWeightEntry,
  currentActivation,
  livePatientQueryKey,
  useCanEditLiveRecord,
} from "@/components/office/LivePatientEdits";

/**
 * Demo actions (logging a weight, adding a note) are stamped with the fixed
 * demo anchor — the same instant the seeded record uses — never the viewer's
 * clock, so a session's new entries always land on the synthetic "today".
 */
const ANCHOR_ISO = `${TODAY_KEY}T12:00:00.000Z`;

function ProductImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <PackageOpen size={18} className="text-muted-foreground" aria-label={`${alt} image unavailable`} /> : (
    <img src={src} alt={alt} className="h-full w-full object-cover" onError={() => setFailed(true)} />
  );
}

const formatDate = (date: string, includeYear = false, includeTime = false) => {
  const value = new Date(date);
  const day = value.toLocaleDateString("en-US", includeYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  return includeTime
    ? `${day} · ${value.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : day;
};

function StatusBadge({ status }: { status: string }) {
  const chip = status === "active" || status === "graduated"
    ? CHIP_COBALT
    : status === "paused" ? CHIP_WARM : CHIP_RISK;
  return <span className={chip}>{status}</span>;
}

function DemoPatientDetail() {
  const { id } = useParams();
  const { toast } = useToast();
  const { addWeightEntry, getCurrentWeight, getProgressHistory, getBodyMeasurements, addMeasurementVisit, removeMeasurementVisit } = usePatientSession();
  // Scoped lookups: inside the HQ drill-in, another office's patient id is
  // simply "not found" here — the umbrella never leaks records across offices.
  const patients = useScopedPatients();
  const providers = useScopedProviders();
  const subscriptions = useScopedSubscriptions();
  const patient = patients.find((candidate) => candidate.id === id);
  const provider = providers.find((candidate) => candidate.id === patient?.providerId);
  const subscription = subscriptions.find((candidate) => candidate.patientId === patient?.id);
  const products = patient?.products
    .map((productId) => MOCK_PRODUCTS.find((product) => product.id === productId))
    .filter((product): product is NonNullable<typeof product> => Boolean(product)) ?? [];
  const [profile, setProfile] = useState(() => ({ email: patient?.email ?? "", phone: patient?.phone ?? "" }));
  const [isEditing, setIsEditing] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>(() => patient?.activity ?? []);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [weightEntryOpen, setWeightEntryOpen] = useState(false);
  const [weightDraft, setWeightDraft] = useState(() => patient ? getCurrentWeight(patient).toString() : "");
  const [subscriptionStatus, setSubscriptionStatus] = useState(subscription?.status ?? "active");
  const [manageOpen, setManageOpen] = useState(false);
  const noteSequenceRef = useRef(0);

  useEffect(() => {
    setProfile({ email: patient?.email ?? "", phone: patient?.phone ?? "" });
    setActivities(patient?.activity ?? []);
    setWeightDraft(patient ? getCurrentWeight(patient).toString() : "");
    setSubscriptionStatus(subscription?.status ?? "active");
    setIsEditing(false);
    setNoteOpen(false);
    setWeightEntryOpen(false);
    setManageOpen(false);
  }, [id, patient, subscription]);

  const weightEntries = patient ? getProgressHistory(patient) : [];
  const sortedWeights = useMemo(
    () => [...weightEntries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [weightEntries],
  );

  if (!patient) {
    return <div className="mx-auto max-w-[1320px] px-5 py-12 text-center"><h2 className="mb-4 font-serif text-xl font-bold text-navy">Patient Not Found</h2><Link href="/patients" className={LINK_ACTION}>Return to roster</Link></div>;
  }

  // Companion-app coach outreach (stalled weight + repeated off-plan
  // logging). Computed from the same seeded record the app uses, so the
  // roster chip, this card, and the patient's own chat all agree.
  const nudge = getNudgeAssessment(patient);

  const currentWeight = sortedWeights.at(-1)?.weight ?? patient.currentWeight;
  const weightLoss = patient.startingWeight - currentWeight;
  const percentageLoss = patient.startingWeight ? (weightLoss / patient.startingWeight) * 100 : 0;
  const goalLoss = patient.startingWeight - patient.goalWeight;
  const goalProgress = goalLoss ? (weightLoss / goalLoss) * 100 : 0;
  const poundsToGoal = Math.max(0, currentWeight - patient.goalWeight);
  const orderedWeights = [...sortedWeights].reverse();
  const orderedActivities = [...activities].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const addWeight = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextWeight = Number(weightDraft);
    if (!Number.isFinite(nextWeight) || nextWeight <= 0) {
      toast({ variant: "destructive", title: "Enter a valid weight", description: "Use a positive number in pounds." });
      return;
    }
    addWeightEntry(patient, { date: ANCHOR_ISO, weight: nextWeight });
    setWeightDraft(nextWeight.toString());
    setWeightEntryOpen(false);
    toast({ variant: "success", title: "Weight entry logged", description: `${nextWeight.toFixed(1)} lbs is now reflected across this session’s record.` });
  };

  const addNote = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const note = noteDraft.trim();
    if (!note) return;
    setActivities((current) => [
      { id: `local-note-${++noteSequenceRef.current}`, date: ANCHOR_ISO, type: "note", description: note, user: provider?.name ?? "Care team" },
      ...current,
    ]);
    setNoteDraft("");
    setNoteOpen(false);
    toast({ variant: "success", title: "Clinical note added", description: "Saved to this synthetic session." });
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <header className="mb-6 border-b border-border pb-6">
        <Link href="/patients" className="mb-4 inline-flex items-center rounded-sm text-xs font-semibold text-muted-foreground transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft size={14} className="mr-1" />Back to patients</Link>
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="flex items-start gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-accent-border bg-accent text-xl font-bold text-primary shadow-soft">{patient.initials}</div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-serif text-[30px] font-bold leading-none tracking-[-.02em] text-navy md:text-[32px]">{patient.name}</h1>
                <StatusBadge status={patient.status} />
                <span className={CHIP_WARM}>Synthetic record</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">Patient record <span className="font-mono">#{patient.id.replace("pat_", "")}</span> · Provider: <b className="text-foreground">{provider?.name ?? "Unassigned"}</b></p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Mail size={13} className="text-primary" />{profile.email}</span><span className="flex items-center gap-1.5"><Phone size={13} className="text-primary" />{profile.phone}</span></div>
            </div>
          </div>
          <button onClick={() => setIsEditing((open) => !open)} className={`${BTN_SECONDARY} h-9 px-4`}><Edit2 size={14} className="text-primary" />{isEditing ? "Close editor" : "Edit patient"}</button>
        </div>
        {isEditing && <form className="mt-5 grid gap-3 rounded-lg border border-border bg-secondary p-4 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); setIsEditing(false); toast({ variant: "success", title: "Patient profile updated", description: "The synthetic record was updated for this session." }); }}>
          <label className={PANEL_LABEL}>Email<input type="email" required value={profile.email} onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))} className={`${INPUT_CLASS} mt-1 block h-9 w-full`} /></label>
          <label className={PANEL_LABEL}>Phone<input type="tel" required value={profile.phone} onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))} className={`${INPUT_CLASS} mt-1 block h-9 w-full`} /></label>
          <button className={`${BTN_PRIMARY} h-9 self-end px-4`}>Save changes</button>
        </form>}
      </header>

      <main className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <SectionCard
            title="Progress at a glance"
            sub={patient.stage === "protocol" ? `Week ${patient.protocolWeek} of 6 · ${patient.carePlan.protocolStatus}` : "Maintenance phase · routine monitoring"}
            action={<span className={CHIP_COBALT}>{formatDate(sortedWeights.at(-1)?.date ?? patient.startDate, true)} reading</span>}
          >
            <div className="p-5 md:p-6">
              <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
                {[["Starting", `${patient.startingWeight.toFixed(1)} lbs`, "text-navy"], ["Current", `${currentWeight.toFixed(1)} lbs`, "text-primary"], ["Lost to date", `${weightLoss.toFixed(1)} lbs`, "text-navy"], ["To goal", `${poundsToGoal.toFixed(1)} lbs`, "text-navy"]].map(([label, value, color]) => <div key={label} className="bg-card p-4"><p className={MICRO_LABEL}>{label}</p><p className={`mt-1 font-mono text-xl ${color}`}>{value}</p></div>)}
              </div>
              <div className="mt-5 space-y-2"><div className="flex justify-between text-xs font-semibold"><span className="text-muted-foreground">Goal completion · {percentageLoss.toFixed(1)}% of baseline</span><span className="text-primary">{Math.max(0, goalProgress).toFixed(0)}%</span></div><div className="h-2.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all duration-700" style={{ width: `${Math.min(100, Math.max(0, goalProgress))}%` }} /></div><p className="text-right text-[10px] text-muted-foreground">Goal reference: {patient.goalWeight.toFixed(1)} lbs</p></div>
            </div>
          </SectionCard>

          <SectionCard
            title="Weight trend"
            sub="Logged history from enrollment through the latest reading — full record, independent of the selected range."
            action={<button onClick={() => setWeightEntryOpen((open) => !open)} className={`${BTN_SECONDARY} h-8 px-3`}>{weightEntryOpen ? "Cancel" : "Log weight"}</button>}
          >
            <div className="p-5">
              {weightEntryOpen && <form className="mb-5 flex flex-col gap-2 rounded-md border border-border bg-secondary p-3 sm:flex-row sm:items-end" onSubmit={addWeight}><label className={`flex-1 ${PANEL_LABEL}`}>Current weight (lbs)<input type="number" min="50" max="800" step="0.1" required value={weightDraft} onChange={(event) => setWeightDraft(event.target.value)} className={`${INPUT_CLASS} mt-1 block h-9 w-full font-mono`} /></label><button className={`${BTN_PRIMARY} h-9 px-4`}>Add entry</button></form>}
              <WeightTrend entries={sortedWeights} goalWeight={patient.goalWeight} startingWeight={patient.startingWeight} patientName={patient.name} />
              <div className="mt-5 overflow-x-auto rounded-md border border-border"><table className="w-full min-w-[460px] text-left text-xs"><caption className="sr-only">Logged weigh-ins for {patient.name}</caption><thead className="bg-secondary text-[9px] uppercase tracking-[.12em] text-muted-foreground"><tr><th className="px-3 py-2 font-bold">Date</th><th className="px-3 py-2 font-bold">Weight</th><th className="px-3 py-2 font-bold">From baseline</th><th className="px-3 py-2 font-bold">To goal</th></tr></thead><tbody>{orderedWeights.map((entry, index) => { const loss = patient.startingWeight - entry.weight; const change = loss === 0 ? "Baseline" : loss > 0 ? `${loss.toFixed(1)} lbs lost` : `${Math.abs(loss).toFixed(1)} lbs above baseline`; return <tr key={`${entry.date}-${index}`} className="border-t border-border"><td className="px-3 py-2.5 text-muted-foreground">{formatDate(entry.date, true)}</td><td className="px-3 py-2.5 font-mono font-semibold text-navy">{entry.weight.toFixed(1)} lbs</td><td className="px-3 py-2.5 text-primary">{change}</td><td className="px-3 py-2.5 text-muted-foreground">{Math.max(0, entry.weight - patient.goalWeight).toFixed(1)} lbs</td></tr>; })}</tbody></table></div>
            </div>
          </SectionCard>

          <BodyMeasurementsCard
            visits={getBodyMeasurements(patient)}
            patientName={patient.name}
            canEdit
            todayKey={TODAY_KEY}
            onSave={async (draft) => {
              const visit: MeasurementVisit = { id: `visit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, ...draft, recordedByName: provider?.name ?? "Care team" };
              addMeasurementVisit(patient, visit);
              toast({ variant: "success", title: "Visit logged", description: `${Object.keys(draft.measurements).length} measurement${Object.keys(draft.measurements).length === 1 ? "" : "s"} saved to this session's record.` });
              return { ok: true };
            }}
            onRemove={(visit) => {
              removeMeasurementVisit(patient, visit.id);
              toast({ variant: "success", title: "Visit removed", description: "Removed from this synthetic session." });
            }}
          />

          <SectionCard title="Clinical activity and notes">
            <div className="p-5">
              <div className="mb-5 rounded-md border border-border bg-secondary p-3">
                <p className={MICRO_LABEL}>Care summary</p>
                {patient.notes.length ? (
                  <ul className="mt-2 space-y-2 text-xs leading-5 text-foreground">
                    {patient.notes.map((note) => <li key={note} className="border-l-2 border-accent-border pl-3">{note}</li>)}
                  </ul>
                ) : <p className="mt-2 text-xs text-muted-foreground">No care-summary notes recorded.</p>}
              </div>
              {noteOpen ? <form className="mb-4 rounded-md border border-border bg-secondary p-3" onSubmit={addNote}><label className={PANEL_LABEL}>Internal note<textarea required value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add a concise internal note" className={`${INPUT_CLASS} mt-1 min-h-20 w-full resize-y p-3`} /></label><div className="mt-2 flex items-center gap-3"><button className={`${BTN_PRIMARY} px-4 py-2`}>Save note</button><button type="button" onClick={() => setNoteOpen(false)} className="rounded-sm text-xs font-semibold text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Cancel</button></div></form> : <button onClick={() => setNoteOpen(true)} className={`mb-3 inline-flex items-center gap-1 ${LINK_ACTION}`}><FileText size={13} />Add note</button>}
              <div className="divide-y divide-border">{orderedActivities.length ? orderedActivities.map((activity) => <div key={activity.id} className="flex gap-3 py-3 first:pt-0 last:pb-0"><div className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md ${activity.type === "check_in" ? "bg-accent text-primary" : "bg-secondary text-muted-foreground"}`}>{activity.type === "check_in" ? <CheckCircle2 size={15} /> : activity.type === "fulfillment" ? <Truck size={15} /> : <FileText size={15} />}</div><div><p className="text-sm text-foreground">{activity.description}</p><p className="mt-1 text-[10px] text-muted-foreground">{formatDate(activity.date, true)} · {activity.user}</p></div></div>) : <p className="text-xs text-muted-foreground">No activity has been recorded.</p>}</div>
            </div>
          </SectionCard>
        </div>

        <aside className="space-y-5">
          {nudge.active && nudge.crossedOnKey && (
            <SectionCard title="Coach outreach" sub="Triggers automatically in the companion app — informational, no approval step.">
              <div className="p-5">
                <p className="text-xs leading-5 text-foreground">
                  {patient.name.split(" ")[0]}'s signals crossed the program's outreach threshold on <b className="text-navy">{formatDate(`${nudge.crossedOnKey}T12:00:00.000Z`, true)}</b>. From there the app coach opens a back-on-track conversation: their own trend, an invitation to reset, and a plan drawn from the approved list. A personal follow-up from the care team lands well right now.
                </p>
                <dl className="mt-4 space-y-3 border-t border-border pt-3 text-xs">
                  <div>
                    <dt className={MICRO_LABEL}>Weight signal</dt>
                    <dd className="mt-1 leading-5 text-muted-foreground">
                      Weigh-ins over the past three weeks are holding near {currentWeight.toFixed(1)} lbs
                      {nudge.stall.dropLb !== null && <> (net {nudge.stall.dropLb >= 0 ? "down" : "up"} {Math.abs(nudge.stall.dropLb).toFixed(1)} lbs)</>}, inside the program's stall threshold.
                    </dd>
                  </div>
                  <div>
                    <dt className={MICRO_LABEL}>Diary signal</dt>
                    <dd className="mt-1 leading-5 text-muted-foreground">
                      {nudge.adherence.offPlan} of {nudge.adherence.classified} recognized diary items in the last {ADHERENCE_WINDOW_DAYS} days were off the approved list
                      {nudge.adherence.offPlanShare !== null && <> ({Math.round(nudge.adherence.offPlanShare * 100)}%)</>}.
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 border-t border-border pt-3 text-[10px] leading-4 text-muted-foreground">
                  The app sends at most one of these per patient every {NUDGE_COOLDOWN_DAYS} days, stops as soon as the patient engages, and patients can turn the nudges off — delivery, engagement, and opt-out live in the patient's app.
                </p>
              </div>
            </SectionCard>
          )}
          <SectionCard title="Care plan">
            <div className="p-5">
              <div className="space-y-4 text-xs"><div><p className="font-serif text-sm font-bold text-navy">{patient.carePlan.name}</p><p className="mt-1 leading-5 text-muted-foreground">{patient.carePlan.focus}</p></div><dl className="space-y-3 border-t border-border pt-3"><div><dt className={MICRO_LABEL}>Plan status</dt><dd className="mt-1 font-semibold text-foreground">{patient.carePlan.protocolStatus}</dd></div><div><dt className={MICRO_LABEL}>Care cadence</dt><dd className="mt-1 text-muted-foreground">{patient.carePlan.cadence}</dd></div><div><dt className={MICRO_LABEL}>Upcoming action</dt><dd className="mt-1 text-muted-foreground">{patient.carePlan.nextMilestone}</dd></div></dl></div>
            </div>
          </SectionCard>
          <SectionCard title="Adherence and check-ins">
            <div className="p-5">
              <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-md border border-accent-border bg-accent font-mono text-sm font-bold text-primary">{patient.adherence}%</div><div><p className="text-xs font-semibold text-foreground">Routine adherence</p><p className="mt-0.5 text-[10px] text-muted-foreground">{patient.adherenceDetail.recentPattern}</p></div></div>
              <div className="mt-4 border-t border-border pt-3"><p className={MICRO_LABEL}>Recent check-ins</p><div className="mt-2 space-y-3">{patient.checkIns.length ? patient.checkIns.map((checkIn) => <div key={checkIn.date}><div className="flex justify-between gap-2 text-[10px]"><span className="font-semibold text-primary">{checkIn.mood}</span><span className="text-muted-foreground">{formatDate(checkIn.date)}</span></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{checkIn.summary}</p></div>) : <p className="text-xs text-muted-foreground">No check-ins recorded.</p>}</div><p className="mt-3 border-t border-border pt-3 text-[10px] text-muted-foreground">Check-in completion: <b className="text-foreground">{patient.adherenceDetail.checkInRate}%</b></p></div>
            </div>
          </SectionCard>
          <SectionCard title="Patient details">
            <div className="p-5">
              <dl className="space-y-4 text-xs"><div><dt className={MICRO_LABEL}>Enrollment</dt><dd className="mt-1 flex items-center gap-2 text-foreground"><Calendar size={14} className="text-primary" />{formatDate(patient.startDate, true)}</dd></div><div><dt className={MICRO_LABEL}>Next check-in</dt><dd className="mt-1 flex items-center gap-2 text-foreground"><Target size={14} className="text-primary" />{formatDate(patient.nextCheckIn, true)}</dd></div><div><dt className={MICRO_LABEL}>Assigned provider</dt><dd className="mt-1 text-muted-foreground">{provider?.name ?? "Unassigned"}</dd></div></dl>
            </div>
          </SectionCard>
          <SectionCard title="Active products">
            <div className="p-5">
              <div className="space-y-3">{products.map((product) => <div key={product.id} className="flex gap-3 rounded-md border border-border bg-paper-alt p-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-accent"><ProductImage src={product.imageUrl} alt={`${product.name} product`} /></div><div><p className="font-serif text-[13px] font-bold leading-tight text-navy">{product.name}</p><p className="mt-0.5 text-[10px] capitalize text-muted-foreground">{product.category}</p></div></div>)}</div>
            </div>
          </SectionCard>
          <SectionCard title="Fulfillment">
            <div className="p-5">
              <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xl text-navy">${subscription?.monthlyValue ?? 0}<span className="ml-1 font-sans text-xs text-muted-foreground">/mo</span></p><p className="mt-1 text-xs capitalize text-muted-foreground">{subscription?.cadence ?? "Monthly"} fulfillment · next shipment {subscription?.nextShipment ? formatDate(subscription.nextShipment) : "N/A"}</p></div><StatusBadge status={subscriptionStatus} /></div>
              {manageOpen && <label className={`mt-4 block border-t border-border pt-3 ${PANEL_LABEL}`}>Delivery status<select value={subscriptionStatus} onChange={(event) => setSubscriptionStatus(event.target.value as typeof subscriptionStatus)} className={`${INPUT_CLASS} mt-1 block h-9 w-full px-2`}><option value="active">Active</option><option value="paused">Paused</option><option value="overdue">Overdue</option><option value="cancelled">Cancelled</option></select></label>}
              <button onClick={() => { if (manageOpen) toast({ variant: "success", title: "Fulfillment updated", description: `Status set to ${subscriptionStatus} for this session.` }); setManageOpen((open) => !open); }} className={`${BTN_SECONDARY} mt-4 h-9 w-full`}>{manageOpen ? "Save fulfillment" : "Manage fulfillment"}</button>
            </div>
          </SectionCard>
        </aside>

        <div className="lg:col-span-3">
          <SectionCard title="Bloodwork Reports">
            <EmptyState>Demo only: Bloodwork requires a real patient record.</EmptyState>
          </SectionCard>
        </div>
        <div className="lg:col-span-3">
          <NutritionLifestyle key={patient.id} patient={patient} />
        </div>
      </main>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-border bg-secondary p-6 text-center text-xs text-muted-foreground">{children}</div>;
}

const readableKey = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
const readOnlyValue = (value: unknown) => {
  if (value == null || value === '') return 'Not recorded';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? `${value.length} saved item${value.length === 1 ? '' : 's'}` : 'None';
  return 'Recorded';
};

function AccountList({ title, items, empty }: { title: string; items: unknown[]; empty: string }) {
  return (
    <div className="rounded-md border border-border bg-paper-alt p-3">
      <p className={MICRO_LABEL}>{title}</p>
      {items.length ? <ul className="mt-2 space-y-1.5 text-xs text-foreground">{items.map((item, index) => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
        const name = record?.name ?? record?.title ?? record?.id ?? item;
        const detail = record ? [record.brand, record.serving, record.meal, record.mode].filter((value) => typeof value === 'string').join(' · ') : '';
        return <li key={`${String(name)}-${index}`} className="border-l-2 border-accent-border pl-2"><span>{readOnlyValue(name)}</span>{detail && <span className="block text-[10px] text-muted-foreground">{detail}</span>}</li>;
      })}</ul> : <p className="mt-2 text-xs text-muted-foreground">{empty}</p>}
    </div>
  );
}

function LiveDiaryDay({ day, totals }: { day: { dateKey: string; waterOz?: number; meals: OfficeDiaryEntry[] }; totals?: { calories: number; protein: number; carbs: number; fat: number } }) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-2">
        <b className="text-xs text-navy">{formatDate(day.dateKey, true)}</b>
        <span className="flex items-center gap-1 font-mono text-[11px] text-primary"><Droplets size={13} />{day.waterOz == null ? 'Water not logged' : `${day.waterOz} oz`}</span>
      </div>
      {day.meals.length ? <div className="divide-y divide-border">{day.meals.map((meal) => (
        <div key={meal.id} className="flex justify-between gap-4 px-3 py-2.5">
          <div><p className="text-xs font-semibold text-foreground">{meal.name}</p><p className="mt-0.5 text-[10px] capitalize text-muted-foreground">{meal.meal}{meal.detail ? ` · ${meal.detail}` : ''}</p></div>
          <div className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
            {`${meal.calories} cal`}
            <p>{meal.protein}P · {meal.carbs}C · {meal.fat}F</p>
          </div>
        </div>
      ))}</div> : <p className="p-4 text-xs text-muted-foreground">No meal entries recorded for this day.</p>}
      {totals && <p className="border-t border-border bg-paper-alt px-3 py-2 text-right font-mono text-[10px] text-muted-foreground">Daily total · {totals.calories} cal · {totals.protein}P · {totals.carbs}C · {totals.fat}F</p>}
    </div>
  );
}

function LivePatientDetail({ id, office, isHq }: { id: string; office: string | null; isHq: boolean }) {
  const canEdit = useCanEditLiveRecord();
  const { toast } = useToast();
  const [weightEntryOpen, setWeightEntryOpen] = useState(false);
  const [securityReason, setSecurityReason] = useState<Exclude<SecurityReason, 'staff_request'>>('patient_request');
  const detail = useQuery({
    queryKey: livePatientQueryKey(office, id),
    queryFn: () => fetchOfficePatient(id, office),
    refetchInterval: 30_000,
  });
  const notificationTimeline = useQuery({
    queryKey: ['office-patient-notifications', office ?? 'own', id],
    queryFn: () => fetchOfficePatientNotifications(id, office),
    refetchInterval: 30_000,
  });
  const security = useQuery({
    queryKey: ['patient-security', office, id],
    queryFn: () => fetchPatientSessions(id, office!),
    enabled: isHq && Boolean(office),
    retry: false,
  });
  const forceSignOut = useMutation({
    mutationFn: () => signOutPatientSessions(id, office!, securityReason),
    onSuccess: async () => {
      toast({ variant: 'success', title: 'Patient signed out', description: 'Every active device will need to sign in again.' });
      await security.refetch();
    },
    onError: (error) => toast({ variant: 'destructive', title: 'Could not force sign-out', description: error instanceof Error ? error.message : 'Try again.' }),
  });

  const startConv = useStartOfficeConversation();
  const [, setLocation] = useLocation();
  const messageScopeRef = useRef(`${office ?? 'own'}:${id}`);
  messageScopeRef.current = `${office ?? 'own'}:${id}`;

  const handleMessage = () => {
    if (isHq) return; // shouldn't happen, CTA hidden
    const operationScope = messageScopeRef.current;
    startConv.mutate({ data: { patientId: id } }, {
      onSuccess: (res) => {
        if (messageScopeRef.current !== operationScope) return;
        setLocation(`/conversations?channel=care_team&conversation=${res.conversation.id}`);
      },
      onError: (error) => {
        if (messageScopeRef.current !== operationScope) return;
        toast({ variant: 'destructive', title: 'Could not start conversation', description: error instanceof Error ? error.message : 'Try again.' });
      }
    });
  };

  if (detail.isLoading) return <div className="mx-auto max-w-[1320px] px-5 py-12 text-center text-sm text-muted-foreground">Loading patient record…</div>;
  if (detail.isError && detail.error instanceof OfficeRosterError && detail.error.isDeleted) {
    return <div className="mx-auto max-w-[720px] px-5 py-12"><DeletedRecordNotice message={detail.error.message} deleted={detail.error.deleted} /></div>;
  }
  if (detail.isError) return <div className="mx-auto max-w-[1320px] px-5 py-12 text-center"><h2 className="font-serif text-xl font-bold text-navy">Patient record unavailable</h2><p className="mt-2 text-sm text-destructive" role="alert">{detail.error instanceof Error ? detail.error.message : 'The patient record could not be loaded.'}</p><Link href="/patients" className={`mt-4 ${LINK_ACTION}`}>Return to roster</Link></div>;
  if (!detail.data) return null;

  const record: OfficePatientDetail = detail.data;
  const identity = record.patient.identity;
  const program = record.patient.program;
  const weights = [...record.weights].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const staffWeightsById = new Map((record.staffWeights ?? []).map((entry) => [entry.id, entry]));
  const providerNotes = record.providerNotes ?? [];
  const checkIns = [...record.checkIns].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  const waterByDate = new Map(record.water.map((item) => [item.dateKey, item.oz]));
  const diaryByDate = new Map<string, OfficeDiaryEntry[]>();
  record.diary.entries.forEach((entry) => {
    diaryByDate.set(entry.dateKey, [...(diaryByDate.get(entry.dateKey) ?? []), entry]);
  });
  const diary = [...new Set([...diaryByDate.keys(), ...waterByDate.keys()])]
    .sort((a, b) => b.localeCompare(a))
    .map((dateKey) => ({ dateKey, waterOz: waterByDate.get(dateKey), meals: diaryByDate.get(dateKey) ?? [] }));
  const totalsByDate = new Map(record.diary.nutritionTotals.byDate.map((item) => [item.dateKey, item]));
  const photos = [...record.progressPhotos].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const currentWeight = weights.at(-1)?.weight ?? program.currentWeight;
  const startingWeight = program.startingWeight ?? weights.at(0)?.weight ?? null;
  const weightLoss = startingWeight != null && currentWeight != null ? startingWeight - currentWeight : null;
  const initials = identity.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const activation = currentActivation(identity.activationStatus);
  const headerStatus = activation ?? identity.activationStatus ?? (identity.verified ? 'active' : 'pending');
  // Staff weigh-ins only make sense once the patient has connected; the
  // status control is likewise hidden until then (nothing to pause).
  const canRecordWeight = canEdit && activation !== null;

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8" data-testid={`live-patient-detail-${identity.id}`}>
      <header className="mb-6 border-b border-border pb-6">
        <Link href="/patients" data-testid="link-back-to-patients" className="mb-4 inline-flex items-center rounded-sm text-xs font-semibold text-muted-foreground hover:text-navy"><ArrowLeft size={14} className="mr-1" />Back to patients</Link>
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="flex items-start gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-accent-border bg-accent text-xl font-bold text-primary">{initials}</div>
            <div>
              <div className="flex flex-wrap items-center gap-3"><h1 className="font-serif text-[30px] font-bold leading-none text-navy" data-testid="text-live-patient-name">{identity.name}</h1><StatusBadge status={headerStatus === 'activated' ? 'active' : headerStatus} /></div>
              <p className="mt-2 text-sm text-muted-foreground">Patient record <span className="font-mono">#{identity.id}</span> · {record.office.officeName}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Mail size={13} className="text-primary" />{identity.email ?? 'No email on file'}</span><span className="flex items-center gap-1.5"><Phone size={13} className="text-primary" />{identity.phoneDisplay ?? identity.phone ?? 'No phone on file'}</span></div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!isHq && <button onClick={handleMessage} disabled={startConv.isPending} className={`${BTN_PRIMARY} h-9 px-4`} data-testid="button-message-patient">{startConv.isPending ? 'Starting...' : 'Message'}</button>}
            {canEdit && <EditPatientProfile patient={record.patient} office={office} />}
          </div>
        </div>
        {record.patient.deletion && <div className="mt-5"><DeletionBanner deletion={record.patient.deletion} /></div>}
      </header>
      <main className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <SectionCard title="Progress at a glance" sub={program.id ? 'Program enrollment summary' : 'No program enrollment recorded'}>
            <div className="p-5">
              <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
                {[['Starting', startingWeight], ['Current', currentWeight], ['Lost to date', weightLoss]].map(([label, value]) => <div key={String(label)} className="bg-card p-4"><p className={MICRO_LABEL}>{label}</p><p className="mt-1 font-mono text-xl text-navy">{typeof value === 'number' ? `${value.toFixed(1)} lbs` : '—'}</p></div>)}
              </div>
            </div>
          </SectionCard>
          <SectionCard
            title="Weight trend"
            sub="Patient check-ins and staff-recorded weigh-ins, oldest to newest."
            action={canRecordWeight ? <button type="button" onClick={() => setWeightEntryOpen((open) => !open)} className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-log-weight">{weightEntryOpen ? 'Cancel' : 'Log weight'}</button> : undefined}
          >
            <div className="p-5">
              {canRecordWeight && <StaffWeightEntry patient={record.patient} office={office} open={weightEntryOpen} onClose={() => setWeightEntryOpen(false)} />}
              {weights.length && startingWeight != null ? <><WeightTrend entries={weights.map((entry) => ({ date: entry.dateKey, weight: entry.weight }))} goalWeight={program.goalWeight} startingWeight={startingWeight} patientName={identity.name} /><ul className="mt-4 divide-y divide-border rounded-md border border-border" data-testid="list-weigh-ins">{[...weights].reverse().map((entry) => { const staff = entry.source === 'staff' && entry.id ? staffWeightsById.get(entry.id) : undefined; return <li key={`${entry.dateKey}-${entry.source ?? 'patient'}-${entry.id ?? entry.weight}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs" data-testid={`weigh-in-${entry.dateKey}-${entry.source ?? 'patient'}`}><span className="text-muted-foreground">{formatDate(`${entry.dateKey}T12:00:00Z`, true)}</span><span className="flex items-center gap-3"><span className={`text-[10px] ${entry.source === 'staff' ? 'text-primary' : 'text-muted-foreground'}`}>{entry.source === 'staff' ? `Staff · ${staff?.recordedByName ?? 'office'}${staff?.note ? ` · ${staff.note}` : ''}` : 'Patient check-in'}</span><b className="font-mono text-navy">{entry.weight.toFixed(1)} lbs</b>{canEdit && staff && <StaffWeightActions patient={record.patient} entry={staff} office={office} />}</span></li>; })}</ul></> : <EmptyState>No weigh-ins have been recorded.</EmptyState>}
            </div>
          </SectionCard>
          <LiveBodyMeasurements patient={record.patient} visits={record.bodyMeasurements ?? []} office={office} canEdit={canRecordWeight} />
          <LiveMedications patient={record.patient} office={office} canEdit={canEdit} />
          <SectionCard title="Provider notes" sub="Internal care-team notes on this record.">
            <ProviderNotes patient={record.patient} notes={providerNotes} office={office} canEdit={canEdit} />
          </SectionCard>
          <SectionCard title="Engagement" sub="Logging, check-in, and wellbeing signals — identical to this patient's roster row.">
            <div className="p-5">
              {record.engagement ? <EngagementSummary signals={record.engagement} /> : <EmptyState>Engagement signals are not available for this record.</EmptyState>}
              <div className="mt-4 border-t border-border pt-3 text-xs">
                <span className="text-muted-foreground">Medication adherence (30d)</span>
                <b className="float-right font-mono text-navy" data-testid="detail-medication-adherence">
                  {record.medicationAdherence?.rate == null ? '—' : `${record.medicationAdherence.rate}%`}
                </b>
              </div>
            </div>
          </SectionCard>
          <SectionCard title="Nutrition, water, and diary" sub="Entries recorded in the patient companion app.">
            <div className="space-y-3 p-5">{diary.length ? <><div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">{Object.entries(record.diary.nutritionTotals.overall).map(([name, value]) => <div key={name} className="bg-card p-3"><p className={MICRO_LABEL}>{name}</p><p className="mt-1 font-mono text-sm text-navy">{value}{name === 'calories' ? ' cal' : ' g'}</p></div>)}</div>{diary.map((day) => <LiveDiaryDay key={day.dateKey} day={day} totals={totalsByDate.get(day.dateKey)} />)}</> : <EmptyState>No nutrition or water entries have been recorded.</EmptyState>}</div>
          </SectionCard>
        </div>
        <aside className="space-y-5">
          {isHq && (
            <SectionCard title="Sessions" sub="Patient account access. Visible to HQ only.">
              <div className="p-5" data-testid="patient-security-card">
                {security.isPending && <p className="text-xs text-muted-foreground">Loading sessions…</p>}
                {security.isError && <div role="alert"><p className="text-xs text-destructive">{security.error instanceof Error ? security.error.message : 'Sessions could not be loaded.'}</p><button type="button" className={`${BTN_SECONDARY} mt-3 h-8 px-3`} onClick={() => void security.refetch()}>Try again</button></div>}
                {security.data && <>
                  {!security.data.linked ? <p className="text-xs text-muted-foreground">This patient has not linked a sign-in account yet.</p> : <div className="space-y-4">
                    <div><p className={MICRO_LABEL}>Active sessions</p>{security.data.sessions.length ? <ul className="mt-2 divide-y divide-border rounded-md border border-border">{security.data.sessions.map((row) => <li key={row.ref} className="p-3"><b className="text-xs text-navy">{row.device}</b><p className="mt-1 text-[10px] text-muted-foreground">{row.region ?? 'Region unavailable'} · Last seen {formatDate(row.lastSeenAt, true, true)}</p></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No active sessions.</p>}</div>
                    <div><p className={MICRO_LABEL}>Recent sign-ins</p>{security.data.signIns.length ? <ul className="mt-2 divide-y divide-border rounded-md border border-border">{security.data.signIns.map((row) => <li key={row.id} className="p-3"><b className="text-xs text-navy">{row.device}</b><p className="mt-1 text-[10px] text-muted-foreground">{formatDate(row.at, true, true)} · {row.region ?? 'Region unavailable'} · {row.methodLabel}</p></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No recent sign-ins.</p>}</div>
                  </div>}
                  <label className={`mt-4 block ${PANEL_LABEL}`}>Force sign-out reason
                    <select data-testid="select-patient-sign-out-reason" className={`${INPUT_CLASS} mt-1 block h-9 w-full px-2`} value={securityReason} onChange={(event) => setSecurityReason(event.target.value as Exclude<SecurityReason, 'staff_request'>)}>
                      <option value="lost_device">Lost device</option><option value="suspicious_activity">Suspicious activity</option><option value="patient_request">Patient request</option><option value="other">Other</option>
                    </select>
                  </label>
                  <button type="button" data-testid="button-patient-force-sign-out" className={`${BTN_SECONDARY} mt-3 h-9 w-full text-destructive`} disabled={forceSignOut.isPending || !security.data.linked} onClick={() => forceSignOut.mutate()}>{forceSignOut.isPending ? 'Signing out…' : 'Force sign-out'}</button>
                </>}
              </div>
            </SectionCard>
          )}
          <CoachOutreachTimeline
            payload={notificationTimeline.data}
            isLoading={notificationTimeline.isLoading}
            error={notificationTimeline.isError
              ? notificationTimeline.error instanceof Error
                ? notificationTimeline.error
                : new Error('Notification history could not be loaded.')
              : null}
            formatTimestamp={(date) => formatDate(date, true, true)}
          />
          {canEdit && activation && (
            <SectionCard title="Program status">
              <div className="p-5"><PatientStatusControl patient={record.patient} office={office} /></div>
            </SectionCard>
          )}
          {!canEdit && activation && activation !== 'activated' && (
            <SectionCard title="Program status">
              <div className="p-5 text-xs" data-testid="section-activation-status"><p className="text-sm font-semibold capitalize text-foreground" data-testid="text-activation-status">{activation}</p>{identity.activationReason && <p className="mt-1 leading-5 text-muted-foreground" data-testid="text-activation-reason">{identity.activationReason}</p>}</div>
            </SectionCard>
          )}
          <SectionCard title="Program">
            <div className="p-5">{program.id ? <dl className="space-y-3 text-xs">
              <div><dt className={MICRO_LABEL}>Program ID</dt><dd className="mt-1 font-mono text-foreground">{program.id}</dd></div>
              <div><dt className={MICRO_LABEL}>Enrollment</dt><dd className="mt-1 text-foreground">{program.startDate ? formatDate(program.startDate, true) : 'Not recorded'}</dd></div>
              <div><dt className={MICRO_LABEL}>Goal weight</dt><dd className="mt-1 text-muted-foreground">{program.goalWeight == null ? 'Not recorded' : `${program.goalWeight.toFixed(1)} lbs`}</dd></div>
              <div><dt className={MICRO_LABEL}>Last diary entry</dt><dd className="mt-1 text-muted-foreground">{program.lastLogDate ? formatDate(program.lastLogDate, true) : 'Not recorded'}</dd></div>
            </dl> : <EmptyState>No program details have been recorded.</EmptyState>}</div>
          </SectionCard>
          <SectionCard title="Check-ins">
            <div className="p-5">{checkIns.length ? <div className="space-y-4">{checkIns.map((checkIn) => <div key={checkIn.id} className="border-b border-border pb-3 last:border-0 last:pb-0"><div className="flex justify-between text-[10px]"><b className="text-primary">{checkIn.mood == null ? 'Mood not recorded' : `Mood score ${checkIn.mood}/5`}</b><span className="text-muted-foreground">{formatDate(checkIn.dateKey)}</span></div><p className="mt-1 text-xs text-muted-foreground">{checkIn.notes ?? 'No note was included.'}</p>{checkIn.weight != null && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{checkIn.weight.toFixed(1)} lbs</p>}{checkIn.sideEffects?.length ? <p className="mt-1 text-[10px] text-[#b65c22]">Side effects: {checkIn.sideEffects.join(', ')}</p> : null}</div>)}</div> : <EmptyState>No check-ins have been recorded.</EmptyState>}</div>
          </SectionCard>
          <SectionCard title="Patient details">
            <div className="p-5"><dl className="space-y-3 text-xs"><div><dt className={MICRO_LABEL}>Enrollment</dt><dd className="mt-1 text-foreground">{program.startDate ? formatDate(program.startDate, true) : 'Not recorded'}</dd></div><div><dt className={MICRO_LABEL}>Activation</dt><dd className="mt-1 capitalize text-foreground">{identity.activationStatus ?? (identity.verified ? 'Verified' : 'Pending')}</dd></div><div><dt className={MICRO_LABEL}>Date of birth</dt><dd className="mt-1 text-muted-foreground">{identity.dateOfBirth ? formatDate(identity.dateOfBirth, true) : 'Not recorded'}</dd></div><div><dt className={MICRO_LABEL}>Height</dt><dd className="mt-1 text-muted-foreground">{identity.height ?? 'Not recorded'}</dd></div><div><dt className={MICRO_LABEL}>Timezone</dt><dd className="mt-1 text-muted-foreground">{identity.timezone ?? 'Not recorded'}</dd></div><div><dt className={MICRO_LABEL}>Record created</dt><dd className="mt-1 text-muted-foreground">{identity.createdAt ? formatDate(identity.createdAt, true) : 'Not recorded'}</dd></div><div><dt className={MICRO_LABEL}>Account claimed</dt><dd className="mt-1 text-muted-foreground">{identity.claimedAt ? formatDate(identity.claimedAt, true) : 'Not claimed'}</dd></div><div><dt className={MICRO_LABEL}>Last login</dt><dd className="mt-1 text-muted-foreground">{identity.lastLoginAt ? formatDate(identity.lastLoginAt, true) : 'Not recorded'}</dd></div></dl></div>
          </SectionCard>
          <SectionCard title="Account targets">
            <div className="p-5"><div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border">{Object.entries(record.account.targets).map(([name, value]) => <div key={name} className="bg-card p-3"><p className={MICRO_LABEL}>{readableKey(name)}</p><p className="mt-1 font-mono text-xs text-navy">{value == null ? 'Not recorded' : `${value}${name === 'calories' ? ' cal' : name === 'waterOz' ? ' oz' : ' g'}`}</p></div>)}</div></div>
          </SectionCard>
        </aside>
        <div className="lg:col-span-3">
          <SectionCard title="Progress photos" sub="Milestones uploaded by the patient.">
            <div className="p-5">{photos.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{photos.map((photo) => <figure key={photo.id} className="overflow-hidden rounded-lg border border-border bg-card">{photo.url ? <img src={photo.url} alt={`${photo.label || 'Progress'} photo for ${identity.name}`} className="aspect-square w-full bg-accent object-cover" loading="lazy" /> : <EmptyState>Photo preview unavailable.</EmptyState>}<figcaption className="p-2"><b className="text-xs text-navy">{photo.label || 'Progress photo'}</b><p className="text-[10px] text-muted-foreground">{formatDate(photo.dateKey, true)}{photo.angle ? ` · ${photo.angle}` : ''}</p></figcaption></figure>)}</div> : <EmptyState>No progress photos have been uploaded.</EmptyState>}</div>
          </SectionCard>
        </div>
        <div className="lg:col-span-3">
          <PatientBloodwork patientId={id} office={office} canEdit={canEdit} />
        </div>
        <div className="lg:col-span-3">
          <SectionCard title="Account preferences and saved items" sub="Read-only companion-app account data.">
            <div className="grid gap-4 p-5 md:grid-cols-2">
              <AccountList title="Favorites" items={record.account.favorites} empty="No favorite foods have been saved." />
              <AccountList title="Recent foods" items={record.account.recents} empty="No recent foods have been recorded." />
              <AccountList title="Custom foods" items={record.account.customFoods} empty="No custom foods have been added." />
              <AccountList title="Saved recipes" items={record.account.savedRecipes} empty="No recipes have been saved." />
              <div className="rounded-md border border-border bg-paper-alt p-3 md:col-span-2">
                <p className={MICRO_LABEL}>Account, onboarding, and notifications</p>
                {Object.keys(record.account.flags).length ? <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">{Object.entries(record.account.flags).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{readableKey(key)}</dt><dd className="mt-0.5 text-foreground">{readOnlyValue(value)}</dd></div>)}</dl> : <p className="mt-2 text-xs text-muted-foreground">No account, onboarding, or notification settings have been recorded.</p>}
              </div>
            </div>
          </SectionCard>
        </div>
      </main>
    </div>
  );
}

export default function PatientDetail() {
  const { id } = useParams();
  const { authStatus, authRole } = useSession();
  const scope = useProviderScope();
  const liveEnabled = authStatus === 'signed-in' && (authRole === 'provider_staff' || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
  if (liveEnabled && id) return <LivePatientDetail id={id} office={authRole === 'hq_admin' ? scope?.providerId ?? null : null} isHq={authRole === 'hq_admin'} />;
  return <DemoPatientDetail />;
}
