import { useEffect, useRef, useState } from 'react';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { useLaunchWrite, type LaunchState } from '@/hooks/use-launch';

const titles = ['Meet your patient', 'See the AI coach', 'Respond as the care team', 'Understand payments', 'Explore training', 'Invite your team and patients'];
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** No operational children, live data hooks, checkout or messaging providers are mounted here. */
export function LaunchTourBoundary({ launchData, onExit }: { launchData: LaunchState; onExit: () => void }) {
  const write = useLaunchWrite('tour');
  return <SampleTour step={launchData.tour.step} busy={write.isPending}
    onProgress={async (step, status) => { await write.save({ step, status }); }}
    onExit={onExit} />;
}

export function SampleTour({ step, busy, onProgress, onExit }: {
  step: number; busy: boolean;
  onProgress: (step: number, status: 'active' | 'skipped' | 'completed') => Promise<void>;
  onExit: () => void;
}) {
  const [profile, setProfile] = useState(false);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [refund, setRefund] = useState(false);
  const [lesson, setLesson] = useState(false);
  const [discovery, setDiscovery] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const lock = useRef(false);
  useEffect(() => { heading.current?.focus(); }, [step]);
  const move = async (next: number, status: 'active' | 'skipped' | 'completed', exit = false) => {
    if (busy || lock.current) return;
    lock.current = true; setError('');
    try { await onProgress(next, status); if (exit) onExit(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Tour progress could not be saved. Try again.'); }
    finally { lock.current = false; }
  };
  return <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className={PANEL_LABEL}>Guided tour — sample data</p>
        <h1 ref={heading} tabIndex={-1} className="mt-2 font-serif text-2xl font-bold text-navy">{titles[step]}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Step {step + 1} of 6 · All people, conversations and transactions below are synthetic.</p></div>
      <button className={`${BTN_SECONDARY} h-9 px-4`} disabled={busy} onClick={() => void move(step, 'active', true)}>Exit tour</button>
    </header>
    <p className="rounded-md border border-border bg-secondary p-4 text-sm">You are still signed in to your own practice. Sample actions never send messages, move money, invite anyone, or complete real training.</p>
    <progress aria-label="Tour progress" value={step + 1} max={6} className="h-2 w-full accent-primary" />
    {step === 0 && <SectionCard title="Sample patient · Maya Thompson" sub="A fictional patient learning sustainable daily habits.">
      <div className="space-y-4 p-5"><p className="text-sm">Active program · Week 4 · Last check-in: today</p>
        <button className={`${BTN_PRIMARY} h-9 px-4`} onClick={() => setProfile(!profile)}>{profile ? 'Close sample profile' : 'Open sample profile'}</button>
        {profile && <div className="grid gap-4 sm:grid-cols-3">{[['Starting weight', '180 lb'], ['Current weight', '176 lb'], ['Weekly check-ins', '5 of 7']].map(([label, value]) => <div className="rounded-md border border-border p-4" key={label}><p className={PANEL_LABEL}>{label}</p><p className="mt-2 font-serif text-xl text-navy">{value}</p></div>)}</div>}
        <p className="text-sm text-muted-foreground">In Patients, open a profile to review weight trends, habits and progress together. These sample values are not clinical advice.</p>
      </div></SectionCard>}
    {step === 1 && <SectionCard title="Sample AI-coach conversation" sub="Read-only example, separate from your care-team inbox."><div className="space-y-4 p-5 text-sm">
      <p className="rounded-md bg-secondary p-4"><b>Maya:</b> Busy afternoons make it hard to remember my plan.</p>
      <p className="rounded-md border border-border p-4"><b>AI coach:</b> Could a small reminder before your afternoon break help? Pick one manageable habit for today.</p>
      <p className="rounded-md bg-secondary p-4"><b>Maya:</b> I’ll put a reminder beside my water bottle.</p>
      <p className="text-muted-foreground">Staff review coach context here; sending a care-team response is a different action in the next step. No model request is made during this tour.</p>
    </div></SectionCard>}
    {step === 2 && <SectionCard title="Sample care-team inbox" sub="Practice responding as a person, not as the AI coach."><div className="space-y-4 p-5 text-sm">
      <p className="rounded-md bg-secondary p-4"><b>Maya → Care team:</b> Where can I find my next check-in?</p>
      <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { setReply(draft.trim()); setDraft(''); } }}>
        <label className="block font-semibold" htmlFor="sample-reply">Practice reply</label>
        <textarea id="sample-reply" className={`${INPUT_CLASS} mt-2 min-h-24 w-full p-3`} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} />
        <button className={`${BTN_PRIMARY} mt-3 h-9 px-4`} disabled={!draft.trim()}>Simulate reply</button>
      </form>{reply && <p role="status" className="rounded-md border border-border p-4"><b>Sample reply — not sent:</b> {reply}</p>}
    </div></SectionCard>}
    {step === 3 && <SectionCard title="Sample payment and subscription" sub="A fictional four-week product plan. No Stripe requests."><div className="space-y-4 p-5 text-sm">
      <dl className="grid grid-cols-2 gap-3"><dt>Collected</dt><dd>{money(7198)}</dd><dt>Subscription</dt><dd>Active · every 4 weeks</dd><dt>Refunded</dt><dd>{money(refund ? 7198 : 0)}</dd><dt>Net collected after refunds</dt><dd>{money(refund ? 0 : 7198)}</dd></dl>
      <button className={`${BTN_SECONDARY} h-9 px-4`} disabled={refund} onClick={() => setRefund(true)}>{refund ? 'Sample refund simulated' : 'Simulate full refund'}</button>
      <p role="status">{refund ? 'Only this sample report changed. No money moved; the subscription remains active.' : 'In Payments, review the order before using Refund. Refunds and subscription cancellation are separate actions.'}</p>
      <p className="text-muted-foreground">Payments → Activity and reports show collections and refunds. Actual office net also accounts for fees and shipping.</p>
    </div></SectionCard>}
    {step === 4 && <SectionCard title="Training · sample lesson" sub="Preview learning without marking any real course complete."><div className="space-y-4 p-5 text-sm">
      <button className={`${BTN_PRIMARY} h-9 px-4`} onClick={() => setLesson(!lesson)}>{lesson ? 'Close lesson preview' : 'Preview sample lesson'}</button>
      {lesson && <div className="rounded-md bg-secondary p-4"><h2 className="font-serif text-lg font-bold text-navy">Your first patient check-in</h2><ol className="mt-3 list-decimal space-y-2 pl-5"><li>Review the patient’s recent progress.</li><li>Read context before responding.</li><li>Use the care-team inbox for a personal follow-up.</li></ol><p className="mt-4">Preview only — no training completion recorded.</p></div>}
      <p className="text-muted-foreground">Find assigned courses in Training. Learning is available when you need it, not a requirement to launch.</p>
    </div></SectionCard>}
    {step === 5 && <SectionCard title="Bring your practice to life" sub="Invites are optional and always deliberate."><div className="space-y-4 p-5 text-sm">
      <button className={`${BTN_SECONDARY} h-9 px-4`} onClick={() => setDiscovery(!discovery)}>{discovery ? 'Hide invitation guide' : 'Find invitations and signup code'}</button>
      {discovery && <ul className="list-disc space-y-3 pl-5"><li>Open Team to invite a real teammate, with the correct role.</li><li>Use the patient invitation tools in Patients when you are ready.</li><li>Find your practice’s patient signup code above the roster in Patients. Patients enter it during mobile onboarding. The sample code <b>SAMPLE — NOT VALID</b> cannot enroll anyone.</li></ul>}
      <p className="text-muted-foreground">No invitation is sent here. Exit the tour first to use your real tools. You can replay from Settings or Help.</p>
    </div></SectionCard>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <button className={`${BTN_SECONDARY} h-10 px-4`} disabled={busy} onClick={() => void move(step, 'skipped', true)}>Skip tour</button>
      <div className="flex gap-2"><button className={`${BTN_SECONDARY} h-10 px-4`} disabled={busy || step === 0} onClick={() => void move(step - 1, 'active')}>Back</button>
        <button className={`${BTN_PRIMARY} h-10 px-4`} disabled={busy} onClick={() => void move(Math.min(5, step + 1), step === 5 ? 'completed' : 'active', step === 5)}>{busy ? 'Saving…' : step === 5 ? 'Finish tour' : 'Next'}</button></div>
    </footer>
  </div>;
}