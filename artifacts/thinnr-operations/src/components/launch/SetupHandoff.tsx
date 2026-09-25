import { useEffect, useRef, useState } from 'react';

/** How long the "configuring your account" hand-off stays up. */
export const SETUP_HANDOFF_MS = 5000;
const FADE_MS = 300;
const TICK_MS = 100;

const STAGES = [
  'Saving your practice details',
  'Connecting your payment setup',
  'Preparing your dashboard',
  'Almost ready',
];

/**
 * Put the workspace back at the top. The setup page scrolls the whole window;
 * the workspace scrolls its own content area. Either can carry the old offset
 * from a long setup page into the dashboard.
 */
export function scrollWorkspaceToTop() {
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLElement>('[data-app-scroll]').forEach((el) => {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'auto' });
    else el.scrollTop = 0;
  });
}

/**
 * Full-screen cover shown for a few seconds right after an office finishes
 * practice setup. The dashboard mounts and loads underneath it; when the bar
 * fills, the workspace is scrolled to the top and the cover fades away.
 */
export function SetupHandoff({ officeName, onDone }: { officeName?: string; onDone: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  const coverRef = useRef<HTMLDivElement>(null);
  doneRef.current = onDone;

  useEffect(() => {
    // Anything the setup page left scrolled is reset behind the cover straight away.
    scrollWorkspaceToTop();
    // Keep keyboard focus on the cover, not on the hidden workspace behind it.
    coverRef.current?.focus?.({ preventScroll: true });
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.min(SETUP_HANDOFF_MS, Date.now() - started)), TICK_MS);
    let fade: ReturnType<typeof setTimeout> | undefined;
    const finish = setTimeout(() => {
      clearInterval(timer);
      setElapsed(SETUP_HANDOFF_MS);
      // Scroll again once the dashboard has loaded, then reveal it.
      scrollWorkspaceToTop();
      setLeaving(true);
      fade = setTimeout(() => doneRef.current(), FADE_MS);
    }, SETUP_HANDOFF_MS);
    return () => { clearInterval(timer); clearTimeout(finish); if (fade) clearTimeout(fade); };
  }, []);

  const percent = Math.round((elapsed / SETUP_HANDOFF_MS) * 100);
  const stage = STAGES[Math.min(STAGES.length - 1, Math.floor((elapsed / SETUP_HANDOFF_MS) * STAGES.length))];

  return (
    <div
      ref={coverRef}
      tabIndex={-1}
      data-testid="setup-handoff"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-handoff-title"
      className={`fixed inset-0 z-[100] grid outline-none place-items-center bg-background px-6 transition-opacity duration-300 motion-reduce:transition-none ${leaving ? 'opacity-0' : 'opacity-100'}`}
    >
      <div className="w-full max-w-md rounded-lg border border-card-border bg-card p-8 text-center shadow-soft">
        <p className="text-[11px] font-bold uppercase tracking-[.16em] text-primary">Practice setup complete</p>
        <h1 id="setup-handoff-title" className="mt-3 font-serif text-[28px] leading-tight tracking-[-.02em] text-navy">
          Configuring your account
        </h1>
        {officeName && <p className="mt-2 text-sm text-muted-foreground">Getting {officeName} ready to go.</p>}
        <div
          role="progressbar"
          aria-label="Configuring your account"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-7 h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            data-testid="setup-handoff-bar"
            className="h-full rounded-full bg-primary transition-[width] duration-100 ease-linear motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground" data-testid="text-setup-handoff-stage">
          {stage}…
        </p>
      </div>
    </div>
  );
}
