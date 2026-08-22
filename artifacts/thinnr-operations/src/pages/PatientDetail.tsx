import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Edit2, Mail, Phone, Calendar, Target, Activity, FileText, CheckCircle2, ChevronRight, PackageOpen } from "lucide-react";
import { MOCK_PATIENTS, MOCK_PROVIDERS, MOCK_PRODUCTS, MOCK_SUBSCRIPTIONS } from "@/data/mock-data";
import { useToast } from "@/hooks/use-toast";

function ProductImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  return failed ? (
    <PackageOpen size={18} className="text-[#8793a8]" aria-label={`${alt} image unavailable`} />
  ) : (
    <img
      src={src}
      alt={alt}
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export default function PatientDetail() {
  const { id } = useParams();
  const { toast } = useToast();
  
  const patient = MOCK_PATIENTS.find(p => p.id === id);
  const provider = MOCK_PROVIDERS.find(p => p?.id === patient?.providerId);
  const subscription = MOCK_SUBSCRIPTIONS.find(s => s?.patientId === patient?.id);
  const products = patient?.products
    .map(pid => MOCK_PRODUCTS.find(pr => pr.id === pid))
    .filter((product): product is NonNullable<typeof product> => Boolean(product)) ?? [];
  const [profile, setProfile] = useState(() => ({ email: patient?.email ?? '', phone: patient?.phone ?? '' }));
  const [isEditing, setIsEditing] = useState(false);
  const [activities, setActivities] = useState(() => patient?.activity ?? []);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [weightEntries, setWeightEntries] = useState(() => patient?.progressHistory ?? []);
  const [weightEntryOpen, setWeightEntryOpen] = useState(false);
  const [weightDraft, setWeightDraft] = useState(() => patient?.currentWeight.toString() ?? '');
  const [subscriptionStatus, setSubscriptionStatus] = useState(subscription?.status ?? 'active');
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    setProfile({ email: patient?.email ?? '', phone: patient?.phone ?? '' });
    setActivities(patient?.activity ?? []);
    setWeightEntries(patient?.progressHistory ?? []);
    setWeightDraft(patient?.currentWeight.toString() ?? '');
    setSubscriptionStatus(subscription?.status ?? 'active');
    setIsEditing(false);
    setNoteOpen(false);
    setWeightEntryOpen(false);
    setManageOpen(false);
  }, [patient, subscription]);

  if (!patient) {
    return (
      <div className="mx-auto max-w-[1320px] px-5 py-12 text-center">
        <h2 className="text-xl font-serif text-[#172c56] mb-4">Patient Not Found</h2>
        <Link href="/patients" className="text-[#315fc0] hover:underline">Return to Roster</Link>
      </div>
    );
  }

  const currentWeight = weightEntries.at(-1)?.weight ?? patient.currentWeight;
  const weightLoss = patient.startingWeight - currentWeight;
  const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
  const goalProgress = ((patient.startingWeight - currentWeight) / (patient.startingWeight - patient.goalWeight)) * 100;

  const getStatusColor = (status: string) => {
    if (status === 'active' || status === 'graduated') return "bg-[#eef3fc] text-[#3156a2] border-[#aebfe0]";
    if (status === 'paused') return "bg-[#fff6e5] text-[#97631e] border-[#d7b889]";
    return "bg-[#fff0f0] text-[#a04646] border-[#d5a7a7]";
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      {/* Breadcrumb & Header */}
      <div className="mb-6">
        <div className="mb-4">
          <Link href="/patients" className="inline-flex items-center text-xs font-semibold text-[#64738e] hover:text-[#284675] transition-colors">
            <ArrowLeft size={14} className="mr-1" /> Back to Patients
          </Link>
        </div>
        
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center bg-[#dce6fa] text-xl font-bold text-[#3156a2] shadow-[inset_0_0_0_1px_rgba(49,95,192,0.2)]">
              {patient.initials}
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56]">
                  {patient.name}
                </h1>
                <span className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] font-bold uppercase tracking-[.05em] ${getStatusColor(patient.status)}`}>
                  {patient.status}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-[#53698f]">
                <span className="flex items-center gap-1.5"><Mail size={14}/> {profile.email}</span>
                <span className="flex items-center gap-1.5"><Phone size={14}/> {profile.phone}</span>
                <span className="flex items-center gap-1.5 border-l border-[#bdc9dc] pl-4">Provider: <b>{provider?.name}</b></span>
              </div>
            </div>
          </div>
          
          <div className="flex gap-2">
            <button 
              onClick={() => setIsEditing((current) => !current)}
              className="flex h-9 items-center gap-2 border border-[#bdc9dc] bg-[#f8f9fc] px-4 text-xs font-semibold text-[#344c77] transition hover:border-[#315fc0] hover:bg-[#e9eef8]"
            >
              <Edit2 size={14} /> {isEditing ? 'Close Editor' : 'Edit Patient'}
            </button>
          </div>
        </div>
        {isEditing && (
          <form
            className="mt-4 grid gap-3 border border-[#bdc9dc] bg-[#fbfcff] p-4 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              setIsEditing(false);
              toast({ title: 'Patient profile updated', description: 'The synthetic record was updated for this session.' });
            }}
          >
            <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">
              Email
              <input
                type="email"
                required
                value={profile.email}
                onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))}
                className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-3 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]"
              />
            </label>
            <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">
              Phone
              <input
                type="tel"
                required
                value={profile.phone}
                onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))}
                className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-3 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]"
              />
            </label>
            <button className="h-9 self-end bg-[#315fc0] px-4 text-xs font-bold text-white transition hover:bg-[#172c56] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0] focus-visible:ring-offset-2">
              Save changes
            </button>
          </form>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Left Column: Progress & Vitals */}
        <div className="lg:col-span-2 space-y-5">
          {/* Progress Card */}
          <div className="border border-[#bdc9dc] bg-[#fbfcff] p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#74839d]">Protocol Progress</h2>
              <span className="text-xs font-semibold bg-[#eef3fc] text-[#3156a2] px-2 py-1">
                {patient.stage === 'protocol' ? `Week ${patient.protocolWeek} of 6` : 'Maintenance Phase'}
              </span>
            </div>
            
            <div className="grid grid-cols-3 gap-6 mb-8">
              <div>
                <p className="text-[11px] font-bold uppercase text-[#8793a8] mb-1">Starting</p>
                <p className="font-mono text-2xl text-[#172c56]">{patient.startingWeight}<span className="text-sm text-[#7b879d] ml-1">lbs</span></p>
              </div>
              <div className="border-l border-[#e4e8f0] pl-6">
                <p className="text-[11px] font-bold uppercase text-[#8793a8] mb-1">Current</p>
                 <p className="font-mono text-2xl text-[#315fc0]">{currentWeight}<span className="text-sm text-[#7b879d] ml-1">lbs</span></p>
              </div>
              <div className="border-l border-[#e4e8f0] pl-6">
                <p className="text-[11px] font-bold uppercase text-[#8793a8] mb-1">Goal</p>
                <p className="font-mono text-2xl text-[#172c56]">{patient.goalWeight}<span className="text-sm text-[#7b879d] ml-1">lbs</span></p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs font-semibold">
                <span className="text-[#53698f]">Goal Completion</span>
                <span className="text-[#3156a2]">{goalProgress.toFixed(0)}%</span>
              </div>
              <div className="h-2.5 w-full bg-[#e4e9f2] overflow-hidden">
                <div 
                  className="h-full bg-[#315fc0] transition-all duration-1000" 
                  style={{ width: `${Math.min(100, Math.max(0, goalProgress))}%` }} 
                />
              </div>
              <p className="text-[10px] text-[#7b879d] text-right pt-1">
                Total loss: {weightLoss.toFixed(1)} lbs ({percentLoss}%)
              </p>
            </div>
          </div>

          {/* Timeline / History */}
          <div className="border border-[#bdc9dc] bg-[#fbfcff] p-0">
            <div className="flex items-center justify-between border-b border-[#bdc9dc] p-5">
              <h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#74839d]">Weight History</h2>
              <button
                onClick={() => setWeightEntryOpen((current) => !current)}
                className="text-xs font-semibold text-[#315fc0] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
              >
                {weightEntryOpen ? 'Cancel' : 'Log Entry'}
              </button>
            </div>
            <div className="p-5">
              {weightEntryOpen && (
                <form
                  className="mb-5 flex flex-col gap-2 border border-[#dfe5ef] bg-[#f8f9fc] p-3 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const nextWeight = Number(weightDraft);
                    if (!Number.isFinite(nextWeight) || nextWeight <= 0) return;
                    setWeightEntries((current) => [...current, { date: new Date().toISOString(), weight: nextWeight }]);
                    setWeightEntryOpen(false);
                    toast({ title: 'Weight entry logged', description: `${nextWeight.toFixed(1)} lbs was added to this session.` });
                  }}
                >
                  <label className="flex-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">
                    Current weight (lbs)
                    <input
                      type="number"
                      min="50"
                      max="800"
                      step="0.1"
                      required
                      value={weightDraft}
                      onChange={(event) => setWeightDraft(event.target.value)}
                      className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-3 font-mono text-xs text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]"
                    />
                  </label>
                  <button className="h-9 bg-[#315fc0] px-4 text-xs font-bold text-white hover:bg-[#172c56] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0] focus-visible:ring-offset-2">
                    Add entry
                  </button>
                </form>
              )}
              {/* Simple CSS bar chart for history */}
              <div className="flex h-36 items-end gap-2 mb-4">
                {weightEntries.map((entry, idx) => {
                  const height = ((entry.weight - patient.goalWeight) / (patient.startingWeight - patient.goalWeight)) * 100;
                  return (
                    <div key={`${entry.date}-${idx}`} className="group flex h-full flex-1 flex-col items-center justify-end">
                      <span className="mb-1 opacity-0 text-[10px] font-mono text-[#315fc0] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{entry.weight}</span>
                      <div className="flex h-24 w-full items-end">
                        <div className="w-full bg-[#c6d2ea] transition-colors group-hover:bg-[#315fc0]" style={{ height: `${Math.max(10, Math.min(100, height))}%` }} />
                      </div>
                      <span className="text-[9px] text-[#8793a8] mt-2 whitespace-nowrap overflow-hidden text-ellipsis w-full text-center">
                        {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Activity / Notes Log */}
          <div className="border border-[#bdc9dc] bg-[#fbfcff] p-0">
             <div className="flex items-center justify-between border-b border-[#bdc9dc] p-5">
              <h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#74839d]">Clinical Activity</h2>
              <button 
                onClick={() => setNoteOpen((current) => !current)}
                className="text-xs font-semibold text-[#3156a2] hover:underline flex items-center gap-1"
              >
                <FileText size={13}/> {noteOpen ? 'Cancel' : 'Add Note'}
              </button>
            </div>
            <div className="p-0">
              {noteOpen && (
                <form
                  className="border-b border-[#e4e8f0] bg-[#f8f9fc] p-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const trimmedNote = noteDraft.trim();
                    if (!trimmedNote) return;
                    setActivities((current) => [{
                      id: `act_local_${Date.now()}`,
                      date: new Date().toISOString(),
                      type: 'note',
                      description: trimmedNote,
                      user: 'Dr. Sarah Jenkins',
                    }, ...current]);
                    setNoteDraft('');
                    setNoteOpen(false);
                    toast({ title: 'Clinical note added', description: 'Saved to this synthetic session.' });
                  }}
                >
                  <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">
                    Note
                    <textarea
                      required
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      placeholder="Add a concise internal note"
                      className="mt-1 min-h-20 w-full resize-y border border-[#bdc9dc] bg-white p-3 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]"
                    />
                  </label>
                  <button className="mt-2 bg-[#315fc0] px-4 py-2 text-xs font-bold text-white hover:bg-[#172c56] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0] focus-visible:ring-offset-2">
                    Save note
                  </button>
                </form>
              )}
              {activities.map((act) => (
                <div key={act.id} className="flex gap-4 p-5 border-b border-[#e4e8f0] last:border-0 hover:bg-[#f8f9fc] transition-colors">
                  <div className="mt-1">
                    {act.type === 'check_in' ? (
                      <CheckCircle2 size={16} className="text-[#315fc0]" />
                    ) : (
                      <FileText size={16} className="text-[#8793a8]" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm text-[#172c56]">{act.description}</p>
                    <p className="text-[11px] text-[#7b879d] mt-1 flex items-center gap-2">
                      <span>{new Date(act.date).toLocaleDateString()}</span>
                      <span className="w-1 h-1 rounded-full bg-[#bdc9dc]" />
                      <span>{act.user}</span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Products & Subscription & Metadata */}
        <div className="space-y-5">
          {/* Info Card */}
          <div className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
            <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d] mb-4">Patient Details</h2>
            <div className="space-y-4">
              <div>
                <p className="text-[10px] uppercase text-[#8793a8] font-bold">Start Date</p>
                <p className="text-sm text-[#284675] flex items-center gap-2 mt-1">
                  <Calendar size={14}/> {new Date(patient.startDate).toLocaleDateString()}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-[#8793a8] font-bold">Adherence Score</p>
                <div className="flex items-center gap-2 mt-1">
                  <Activity size={14} className={patient.adherence > 80 ? "text-[#315fc0]" : "text-[#97631e]"}/>
                  <span className={`text-sm font-semibold ${patient.adherence > 80 ? "text-[#284675]" : "text-[#97631e]"}`}>
                    {patient.adherence}/100
                  </span>
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase text-[#8793a8] font-bold">Next Check-in</p>
                <p className="text-sm text-[#284675] flex items-center gap-2 mt-1">
                  <Target size={14}/> {new Date(patient.nextCheckIn).toLocaleDateString()}
                </p>
              </div>
            </div>
          </div>

          {/* Active Products */}
          <div className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
             <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d] mb-4">Active Protocol</h2>
             <div className="space-y-3">
               {products.map(product => (
                 <div key={product?.id} className="flex gap-3 p-3 border border-[#e4e8f0] bg-white">
                    <div className="w-12 h-12 bg-[#f0f3f9] shrink-0 border border-[#e4e8f0] overflow-hidden flex items-center justify-center">
                      <ProductImage src={product.imageUrl} alt={`${product.name} product`} />
                   </div>
                   <div>
                      <p className="text-xs font-bold text-[#172c56]">{product.name}</p>
                      <p className="text-[10px] text-[#7b879d] capitalize mt-0.5">{product.category}</p>
                   </div>
                 </div>
               ))}
             </div>
          </div>

          {/* Subscription */}
          <div className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Subscription</h2>
              <span className={`inline-flex border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(subscriptionStatus)}`}>
                {subscriptionStatus}
              </span>
            </div>
            
            <div className="mb-4">
              <p className="text-2xl font-mono text-[#172c56]">${subscription?.monthlyValue}<span className="text-xs text-[#7b879d] font-sans ml-1">/mo</span></p>
              <p className="text-xs text-[#53698f] mt-1 capitalize">{subscription?.cadence} fulfillment</p>
            </div>
            
            <div className="pt-4 border-t border-[#e4e8f0]">
              <p className="text-xs flex justify-between text-[#53698f] mb-2">
                <span>Next Shipment</span>
                <span className="font-medium text-[#172c56]">
                  {subscription?.nextShipment ? new Date(subscription.nextShipment).toLocaleDateString() : 'N/A'}
                </span>
              </p>
              {manageOpen && (
                <label className="mt-3 block text-[10px] font-bold uppercase tracking-[.1em] text-[#74839d]">
                  Delivery status
                  <select
                    value={subscriptionStatus}
                    onChange={(event) => setSubscriptionStatus(event.target.value as typeof subscriptionStatus)}
                    className="mt-1 block h-9 w-full border border-[#bdc9dc] bg-white px-2 text-xs normal-case tracking-normal text-[#172c56] outline-none focus:ring-2 focus:ring-[#315fc0]"
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="overdue">Overdue</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
              )}
              <button
                onClick={() => {
                  if (manageOpen) {
                    toast({ title: 'Subscription updated', description: `Status set to ${subscriptionStatus} for this session.` });
                  }
                  setManageOpen((current) => !current);
                }}
                className="w-full py-2 border border-[#bdc9dc] text-xs font-semibold text-[#3156a2] hover:bg-[#e9eef8] transition-colors mt-2"
              >
                {manageOpen ? 'Save subscription' : 'Manage Subscription'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
