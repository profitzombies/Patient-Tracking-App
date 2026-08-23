import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
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
} from "lucide-react";
import { MOCK_PATIENTS, MOCK_PRODUCTS, MOCK_PROVIDERS, MOCK_SUBSCRIPTIONS, type ActivityItem } from "@/data/mock-data";
import { TODAY_KEY } from "@/data/nutrition-data";
import { WeightTrend } from "@/components/patient/WeightTrend";
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

const formatDate = (date: string, includeYear = false) =>
  new Date(date).toLocaleDateString("en-US", includeYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });

function StatusBadge({ status }: { status: string }) {
  const chip = status === "active" || status === "graduated"
    ? CHIP_COBALT
    : status === "paused" ? CHIP_WARM : CHIP_RISK;
  return <span className={chip}>{status}</span>;
}

export default function PatientDetail() {
  const { id } = useParams();
  const { toast } = useToast();
  const { addWeightEntry, getCurrentWeight, getProgressHistory } = usePatientSession();
  const patient = MOCK_PATIENTS.find((candidate) => candidate.id === id);
  const provider = MOCK_PROVIDERS.find((candidate) => candidate.id === patient?.providerId);
  const subscription = MOCK_SUBSCRIPTIONS.find((candidate) => candidate.patientId === patient?.id);
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
      toast({ title: "Enter a valid weight", description: "Use a positive number in pounds." });
      return;
    }
    addWeightEntry(patient, { date: ANCHOR_ISO, weight: nextWeight });
    setWeightDraft(nextWeight.toString());
    setWeightEntryOpen(false);
    toast({ title: "Weight entry logged", description: `${nextWeight.toFixed(1)} lbs is now reflected across this session’s record.` });
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
    toast({ title: "Clinical note added", description: "Saved to this synthetic session." });
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
        {isEditing && <form className="mt-5 grid gap-3 rounded-lg border border-border bg-secondary p-4 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); setIsEditing(false); toast({ title: "Patient profile updated", description: "The synthetic record was updated for this session." }); }}>
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
              <button onClick={() => { if (manageOpen) toast({ title: "Fulfillment updated", description: `Status set to ${subscriptionStatus} for this session.` }); setManageOpen((open) => !open); }} className={`${BTN_SECONDARY} mt-4 h-9 w-full`}>{manageOpen ? "Save fulfillment" : "Manage fulfillment"}</button>
            </div>
          </SectionCard>
        </aside>

        <div className="lg:col-span-3">
          <NutritionLifestyle key={patient.id} patient={patient} />
        </div>
      </main>
    </div>
  );
}
