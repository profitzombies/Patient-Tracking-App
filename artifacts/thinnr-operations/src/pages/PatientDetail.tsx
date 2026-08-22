import { useEffect, useMemo, useState } from "react";
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
import { WeightTrend } from "@/components/patient/WeightTrend";
import { usePatientSession } from "@/contexts/patient-session";
import { useToast } from "@/hooks/use-toast";

function ProductImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <PackageOpen size={18} className="text-[#8793a8]" aria-label={`${alt} image unavailable`} /> : (
    <img src={src} alt={alt} className="h-full w-full object-cover" onError={() => setFailed(true)} />
  );
}

const formatDate = (date: string, includeYear = false) =>
  new Date(date).toLocaleDateString("en-US", includeYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });

function StatusBadge({ status }: { status: string }) {
  const color = status === "active" || status === "graduated"
    ? "bg-[#eef3fc] text-[#3156a2] border-[#aebfe0]"
    : status === "paused" ? "bg-[#fff6e5] text-[#97631e] border-[#d7b889]" : "bg-[#fff0f0] text-[#a04646] border-[#d5a7a7]";
  return <span className={`inline-flex border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${color}`}>{status}</span>;
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-[#bdc9dc] bg-[#fbfcff]">
      <h2 className="border-b border-[#bdc9dc] px-5 py-4 text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">{title}</h2>
      <div className="p-5">{children}</div>
    </section>
  );
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
    return <div className="mx-auto max-w-[1320px] px-5 py-12 text-center"><h2 className="mb-4 font-serif text-xl text-[#172c56]">Patient Not Found</h2><Link href="/patients" className="text-[#315fc0] hover:underline">Return to roster</Link></div>;
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
    addWeightEntry(patient, { date: new Date().toISOString(), weight: nextWeight });
    setWeightDraft(nextWeight.toString());
    setWeightEntryOpen(false);
    toast({ title: "Weight entry logged", description: `${nextWeight.toFixed(1)} lbs is now reflected across this session’s record.` });
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <header className="mb-6 border-b border-[#bdc9dc] pb-6">
        <Link href="/patients" className="mb-4 inline-flex items-center text-xs font-semibold text-[#64738e] transition-colors hover:text-[#284675]"><ArrowLeft size={14} className="mr-1" />Back to patients</Link>
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="flex items-start gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center bg-[#dce6fa] text-xl font-bold text-[#3156a2] shadow-[inset_0_0_0_1px_rgba(49,95,192,0.2)]">{patient.initials}</div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56]">{patient.name}</h1>
                <StatusBadge status={patient.status} />
                <span className="border border-[#d7b889] bg-[#fff6e5] px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] text-[#97631e]">Synthetic record</span>
              </div>
              <p className="mt-2 text-sm text-[#53698f]">Patient record <span className="font-mono text-[#718099]">#{patient.id.replace("pat_", "")}</span> · Provider: <b>{provider?.name ?? "Unassigned"}</b></p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#53698f]"><span className="flex items-center gap-1.5"><Mail size={13} />{profile.email}</span><span className="flex items-center gap-1.5"><Phone size={13} />{profile.phone}</span></div>
            </div>
          </div>
          <button onClick={() => setIsEditing((open) => !open)} className="flex h-9 items-center justify-center gap-2 border border-[#bdc9dc] bg-[#f8f9fc] px-4 text-xs font-semibold text-[#344c77] transition hover:border-[#315fc0] hover:bg-[#e9eef8]"><Edit2 size={14} />{isEditing ? "Close editor" : "Edit patient"}</button>
        </div>
        {isEditing && <form className="mt-5 grid gap-3 border border-[#bdc9dc] bg-[#f8f9fc] p-4 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); setIsEditing(false); toast({ title: "Patient profile updated", description: "The synthetic record was updated for this session." }); }}>
          <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">Email<input type="email" required value={profile.email} onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))} className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-3 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]" /></label>
          <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">Phone<input type="tel" required value={profile.phone} onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))} className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-3 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]" /></label>
          <button className="h-9 self-end bg-[#315fc0] px-4 text-xs font-bold text-white transition hover:bg-[#172c56]">Save changes</button>
        </form>}
      </header>

      <main className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <section className="border border-[#bdc9dc] bg-[#fbfcff] p-5 md:p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#74839d]">Progress at a glance</h2><p className="mt-1 text-xs text-[#718099]">{patient.stage === "protocol" ? `Week ${patient.protocolWeek} of 6 · ${patient.carePlan.protocolStatus}` : "Maintenance phase · routine monitoring"}</p></div><span className="border border-[#aebfe0] bg-[#eef3fc] px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#3156a2]">{formatDate(sortedWeights.at(-1)?.date ?? patient.startDate, true)} reading</span></div>
            <div className="grid gap-px border border-[#dfe5ef] bg-[#dfe5ef] sm:grid-cols-4">
              {[["Starting", `${patient.startingWeight.toFixed(1)} lbs`, "text-[#172c56]"], ["Current", `${currentWeight.toFixed(1)} lbs`, "text-[#315fc0]"], ["Lost to date", `${weightLoss.toFixed(1)} lbs`, "text-[#172c56]"], ["To goal", `${poundsToGoal.toFixed(1)} lbs`, "text-[#172c56]"]].map(([label, value, color]) => <div key={label} className="bg-[#fbfcff] p-4"><p className="text-[9px] font-bold uppercase tracking-[.11em] text-[#8793a8]">{label}</p><p className={`mt-1 font-mono text-xl ${color}`}>{value}</p></div>)}
            </div>
            <div className="mt-5 space-y-2"><div className="flex justify-between text-xs font-semibold"><span className="text-[#53698f]">Goal completion · {percentageLoss.toFixed(1)}% of baseline</span><span className="text-[#3156a2]">{Math.max(0, goalProgress).toFixed(0)}%</span></div><div className="h-2.5 overflow-hidden bg-[#e4e9f2]"><div className="h-full bg-[#315fc0] transition-all duration-700" style={{ width: `${Math.min(100, Math.max(0, goalProgress))}%` }} /></div><p className="text-right text-[10px] text-[#7b879d]">Goal reference: {patient.goalWeight.toFixed(1)} lbs</p></div>
          </section>

          <section className="border border-[#bdc9dc] bg-[#fbfcff]">
            <div className="flex items-center justify-between gap-3 border-b border-[#bdc9dc] p-5"><div><h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#74839d]">Weight trend</h2><p className="mt-1 text-xs text-[#718099]">Logged history from enrollment through the latest reading.</p></div><button onClick={() => setWeightEntryOpen((open) => !open)} className="text-xs font-semibold text-[#315fc0] hover:underline">{weightEntryOpen ? "Cancel" : "Log weight"}</button></div>
            <div className="p-5">
              {weightEntryOpen && <form className="mb-5 flex flex-col gap-2 border border-[#dfe5ef] bg-[#f8f9fc] p-3 sm:flex-row sm:items-end" onSubmit={addWeight}><label className="flex-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">Current weight (lbs)<input type="number" min="50" max="800" step="0.1" required value={weightDraft} onChange={(event) => setWeightDraft(event.target.value)} className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-3 font-mono text-xs text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]" /></label><button className="h-9 bg-[#315fc0] px-4 text-xs font-bold text-white hover:bg-[#172c56]">Add entry</button></form>}
              <WeightTrend entries={sortedWeights} goalWeight={patient.goalWeight} startingWeight={patient.startingWeight} patientName={patient.name} />
              <div className="mt-5 overflow-x-auto border border-[#dfe5ef]"><table className="w-full min-w-[460px] text-left text-xs"><caption className="sr-only">Logged weigh-ins for {patient.name}</caption><thead className="bg-[#f8f9fc] text-[9px] uppercase tracking-[.1em] text-[#74839d]"><tr><th className="px-3 py-2 font-bold">Date</th><th className="px-3 py-2 font-bold">Weight</th><th className="px-3 py-2 font-bold">From baseline</th><th className="px-3 py-2 font-bold">To goal</th></tr></thead><tbody>{orderedWeights.map((entry, index) => { const loss = patient.startingWeight - entry.weight; const change = loss === 0 ? "Baseline" : loss > 0 ? `${loss.toFixed(1)} lbs lost` : `${Math.abs(loss).toFixed(1)} lbs above baseline`; return <tr key={`${entry.date}-${index}`} className="border-t border-[#e4e8f0]"><td className="px-3 py-2.5 text-[#53698f]">{formatDate(entry.date, true)}</td><td className="px-3 py-2.5 font-mono font-semibold text-[#172c56]">{entry.weight.toFixed(1)} lbs</td><td className="px-3 py-2.5 text-[#3156a2]">{change}</td><td className="px-3 py-2.5 text-[#53698f]">{Math.max(0, entry.weight - patient.goalWeight).toFixed(1)} lbs</td></tr>; })}</tbody></table></div>
            </div>
          </section>

          <DetailCard title="Clinical activity and notes">
            <div className="mb-5 border border-[#dfe5ef] bg-[#f8f9fc] p-3">
              <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Care summary</p>
              {patient.notes.length ? (
                <ul className="mt-2 space-y-2 text-xs leading-5 text-[#53698f]">
                  {patient.notes.map((note) => <li key={note} className="border-l-2 border-[#aebfe0] pl-3">{note}</li>)}
                </ul>
              ) : <p className="mt-2 text-xs text-[#718099]">No care-summary notes recorded.</p>}
            </div>
            {noteOpen ? <form className="mb-4 border border-[#dfe5ef] bg-[#f8f9fc] p-3" onSubmit={(event) => { event.preventDefault(); const note = noteDraft.trim(); if (!note) return; setActivities((current) => [{ id: `local-${Date.now()}`, date: new Date().toISOString(), type: "note", description: note, user: provider?.name ?? "Care team" }, ...current]); setNoteDraft(""); setNoteOpen(false); toast({ title: "Clinical note added", description: "Saved to this synthetic session." }); }}><label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">Internal note<textarea required value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add a concise internal note" className="mt-1 min-h-20 w-full resize-y border border-[#bdc9dc] bg-white p-3 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]" /></label><div className="mt-2 flex gap-3"><button className="bg-[#315fc0] px-4 py-2 text-xs font-bold text-white hover:bg-[#172c56]">Save note</button><button type="button" onClick={() => setNoteOpen(false)} className="text-xs font-semibold text-[#53698f] hover:underline">Cancel</button></div></form> : <button onClick={() => setNoteOpen(true)} className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-[#3156a2] hover:underline"><FileText size={13} />Add note</button>}
            <div className="divide-y divide-[#e4e8f0]">{orderedActivities.length ? orderedActivities.map((activity) => <div key={activity.id} className="flex gap-3 py-3 first:pt-0 last:pb-0"><div className="mt-0.5">{activity.type === "check_in" ? <CheckCircle2 size={16} className="text-[#315fc0]" /> : activity.type === "fulfillment" ? <Truck size={16} className="text-[#8793a8]" /> : <FileText size={16} className="text-[#8793a8]" />}</div><div><p className="text-sm text-[#172c56]">{activity.description}</p><p className="mt-1 text-[10px] text-[#7b879d]">{formatDate(activity.date, true)} · {activity.user}</p></div></div>) : <p className="text-xs text-[#718099]">No activity has been recorded.</p>}</div>
          </DetailCard>
        </div>

        <aside className="space-y-5">
          <DetailCard title="Care plan">
            <div className="space-y-4 text-xs"><div><p className="font-bold text-[#172c56]">{patient.carePlan.name}</p><p className="mt-1 leading-5 text-[#53698f]">{patient.carePlan.focus}</p></div><dl className="space-y-3 border-t border-[#e4e8f0] pt-3"><div><dt className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Plan status</dt><dd className="mt-1 font-semibold text-[#284675]">{patient.carePlan.protocolStatus}</dd></div><div><dt className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Care cadence</dt><dd className="mt-1 text-[#53698f]">{patient.carePlan.cadence}</dd></div><div><dt className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Upcoming action</dt><dd className="mt-1 text-[#53698f]">{patient.carePlan.nextMilestone}</dd></div></dl></div>
          </DetailCard>
          <DetailCard title="Adherence and check-ins">
            <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center border border-[#aebfe0] bg-[#eef3fc] font-mono text-sm font-bold text-[#3156a2]">{patient.adherence}%</div><div><p className="text-xs font-semibold text-[#172c56]">Routine adherence</p><p className="mt-0.5 text-[10px] text-[#718099]">{patient.adherenceDetail.recentPattern}</p></div></div>
            <div className="mt-4 border-t border-[#e4e8f0] pt-3"><p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Recent check-ins</p><div className="mt-2 space-y-3">{patient.checkIns.length ? patient.checkIns.map((checkIn) => <div key={checkIn.date}><div className="flex justify-between gap-2 text-[10px]"><span className="font-semibold text-[#3156a2]">{checkIn.mood}</span><span className="text-[#8793a8]">{formatDate(checkIn.date)}</span></div><p className="mt-1 text-xs leading-5 text-[#53698f]">{checkIn.summary}</p></div>) : <p className="text-xs text-[#718099]">No check-ins recorded.</p>}</div><p className="mt-3 border-t border-[#e4e8f0] pt-3 text-[10px] text-[#718099]">Check-in completion: <b className="text-[#284675]">{patient.adherenceDetail.checkInRate}%</b></p></div>
          </DetailCard>
          <DetailCard title="Patient details">
            <dl className="space-y-4 text-xs"><div><dt className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Enrollment</dt><dd className="mt-1 flex items-center gap-2 text-[#284675]"><Calendar size={14} />{formatDate(patient.startDate, true)}</dd></div><div><dt className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Next check-in</dt><dd className="mt-1 flex items-center gap-2 text-[#284675]"><Target size={14} />{formatDate(patient.nextCheckIn, true)}</dd></div><div><dt className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Assigned provider</dt><dd className="mt-1 text-[#53698f]">{provider?.name ?? "Unassigned"}</dd></div></dl>
          </DetailCard>
          <DetailCard title="Active products">
            <div className="space-y-3">{products.map((product) => <div key={product.id} className="flex gap-3 border border-[#e4e8f0] bg-white p-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden border border-[#e4e8f0] bg-[#f0f3f9]"><ProductImage src={product.imageUrl} alt={`${product.name} product`} /></div><div><p className="text-xs font-bold text-[#172c56]">{product.name}</p><p className="mt-0.5 text-[10px] capitalize text-[#7b879d]">{product.category}</p></div></div>)}</div>
          </DetailCard>
          <DetailCard title="Fulfillment">
            <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xl text-[#172c56]">${subscription?.monthlyValue ?? 0}<span className="ml-1 font-sans text-xs text-[#7b879d]">/mo</span></p><p className="mt-1 text-xs capitalize text-[#53698f]">{subscription?.cadence ?? "Monthly"} fulfillment · next shipment {subscription?.nextShipment ? formatDate(subscription.nextShipment) : "N/A"}</p></div><StatusBadge status={subscriptionStatus} /></div>
            {manageOpen && <label className="mt-4 block border-t border-[#e4e8f0] pt-3 text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">Delivery status<select value={subscriptionStatus} onChange={(event) => setSubscriptionStatus(event.target.value as typeof subscriptionStatus)} className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-2 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]"><option value="active">Active</option><option value="paused">Paused</option><option value="overdue">Overdue</option><option value="cancelled">Cancelled</option></select></label>}
            <button onClick={() => { if (manageOpen) toast({ title: "Fulfillment updated", description: `Status set to ${subscriptionStatus} for this session.` }); setManageOpen((open) => !open); }} className="mt-4 w-full border border-[#bdc9dc] py-2 text-xs font-semibold text-[#3156a2] transition-colors hover:bg-[#e9eef8]">{manageOpen ? "Save fulfillment" : "Manage fulfillment"}</button>
          </DetailCard>
        </aside>
      </main>
    </div>
  );
}