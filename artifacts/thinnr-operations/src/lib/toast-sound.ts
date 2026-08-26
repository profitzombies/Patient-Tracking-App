/**
 * Toast notification sounds — a soft bell ding for successes and a lower
 * two-note tone for failures, synthesized with the Web Audio API so no
 * audio assets ship with the app.
 *
 * Playback is gated by a persisted per-browser preference (the switch lives
 * on the Org settings page). The module never touches localStorage or
 * AudioContext at import time — in a browser it only attaches first-gesture
 * unlock listeners (see below) — so the same code runs under Node in the
 * verification suite; tests inject a fake context factory and storage via
 * __setToastSoundTestHooks.
 */

export type ToastCueKind = 'success' | 'failure';

export interface CueNote {
  /** Oscillator frequency in Hz. */
  frequency: number;
  /** Oscillator waveform. */
  wave: 'sine' | 'triangle' | 'square' | 'sawtooth';
  /** Offset from the cue start, in seconds. */
  startAt: number;
  /** Seconds from the note's start until it has fully decayed. */
  duration: number;
  /** Peak gain (linear). Deliberately low — these are ambient confirmations. */
  peak: number;
}

export interface ToastCue {
  kind: ToastCueKind;
  notes: CueNote[];
}

/**
 * The cue specs are pure data so the verification suite can assert the two
 * sounds stay distinct without an audio stack.
 *
 * Success: one soft bell strike — a B5 fundamental with two quiet upper
 * partials that give it the "ding" shimmer.
 * Failure: two lower notes falling a tritone (F4 → B3), longer and duller;
 * unmistakably not the bell.
 */
export function toastCue(kind: ToastCueKind): ToastCue {
  if (kind === 'success') {
    return {
      kind,
      notes: [
        { frequency: 987.77, wave: 'sine', startAt: 0, duration: 0.85, peak: 0.06 },
        { frequency: 1975.53, wave: 'sine', startAt: 0, duration: 0.5, peak: 0.022 },
        { frequency: 2637.02, wave: 'sine', startAt: 0, duration: 0.3, peak: 0.01 },
      ],
    };
  }
  return {
    kind,
    notes: [
      { frequency: 349.23, wave: 'triangle', startAt: 0, duration: 0.22, peak: 0.055 },
      { frequency: 246.94, wave: 'triangle', startAt: 0.16, duration: 0.4, peak: 0.06 },
    ],
  };
}

// --- Persisted on/off preference -------------------------------------------

const SOUND_PREF_KEY = 'thinnr-hq-toast-sound';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

let storageOverride: StorageLike | null = null;

function prefStorage(): StorageLike | null {
  if (storageOverride) return storageOverride;
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    // Storage can throw under strict privacy settings — treat as unavailable.
    return null;
  }
}

/** Sounds default ON; only an explicit opt-out silences them. */
export function isToastSoundEnabled(): boolean {
  try {
    return prefStorage()?.getItem(SOUND_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

const prefListeners = new Set<(enabled: boolean) => void>();

export function setToastSoundEnabled(enabled: boolean): void {
  try {
    prefStorage()?.setItem(SOUND_PREF_KEY, enabled ? 'on' : 'off');
  } catch {
    // The preference just won't survive a reload.
  }
  for (const listener of prefListeners) listener(enabled);
}

/** Keeps settings UI in sync if the preference flips elsewhere. */
export function subscribeToastSound(listener: (enabled: boolean) => void): () => void {
  prefListeners.add(listener);
  return () => {
    prefListeners.delete(listener);
  };
}

// --- Web Audio scheduling ---------------------------------------------------

/**
 * Structural slice of AudioContext — everything scheduleCue touches. Lets
 * tests hand in a recorder and keeps the real context assignable.
 */
export interface ToastAudioContext {
  currentTime: number;
  state?: string;
  resume?: () => unknown;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(value: number, time: number): unknown };
    connect(node: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, time: number): unknown;
      linearRampToValueAtTime(value: number, time: number): unknown;
      exponentialRampToValueAtTime(value: number, time: number): unknown;
    };
    connect(node: unknown): unknown;
  };
  destination: unknown;
}

type ContextFactory = () => ToastAudioContext | null;

let contextFactoryOverride: ContextFactory | null = null;
let sharedContext: ToastAudioContext | null = null;

function defaultContextFactory(): ToastAudioContext | null {
  const scope = globalThis as {
    AudioContext?: new () => unknown;
    webkitAudioContext?: new () => unknown;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor() as ToastAudioContext;
  } catch {
    return null;
  }
}

function ensureContext(): ToastAudioContext | null {
  if (!sharedContext) {
    sharedContext = (contextFactoryOverride ?? defaultContextFactory)();
  }
  return sharedContext;
}

// --- Autoplay unlock ---------------------------------------------------------
//
// Browsers keep a fresh AudioContext suspended until a user gesture, and most
// confirmation toasts fire AFTER awaited network/upload work — outside the
// gesture's task, where creating or resuming a context no longer counts as
// user activation. So the context is created and resumed synchronously inside
// the first real gesture (every admin action starts with a pointer or key
// press), and cues later schedule against an already-running context.

/** Create the shared context and try to resume it. Safe to call anywhere. */
export function unlockToastAudio(): void {
  try {
    const ctx = ensureContext();
    if (!ctx || ctx.state === 'running') return;
    void Promise.resolve(ctx.resume?.()).catch(() => {
      // Still locked — the next gesture retries.
    });
  } catch {
    // Sound stays best-effort decoration.
  }
}

let unlockListenersInstalled = false;

function installUnlockListeners(): void {
  if (unlockListenersInstalled) return;
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.addEventListener) return; // Node / SSR: nothing to unlock.
  unlockListenersInstalled = true;
  const removeListeners = () => {
    doc.removeEventListener('pointerdown', onGesture, true);
    doc.removeEventListener('keydown', onGesture, true);
  };
  const onGesture = () => {
    try {
      const ctx = ensureContext();
      if (!ctx) {
        removeListeners(); // No audio stack in this browser; stop listening.
        return;
      }
      if (ctx.state === 'running') {
        removeListeners();
        return;
      }
      void Promise.resolve(ctx.resume?.())
        .then(() => {
          if (sharedContext && sharedContext.state === 'running') removeListeners();
        })
        .catch(() => {
          // Keep the listeners: a later gesture may succeed.
        });
    } catch {
      removeListeners();
    }
  };
  doc.addEventListener('pointerdown', onGesture, true);
  doc.addEventListener('keydown', onGesture, true);
}

installUnlockListeners();

// Dev-only introspection so a browser-level test can prove the unlock landed.
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (globalThis as Record<string, unknown>).__thinnrToastAudioState = () =>
    sharedContext?.state ?? 'uncreated';
}

const ATTACK_SECONDS = 0.008;

function scheduleCue(ctx: ToastAudioContext, cue: ToastCue): void {
  const base = ctx.currentTime + 0.02;
  for (const note of cue.notes) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = base + note.startAt;
    const end = start + note.duration;
    oscillator.type = note.wave;
    oscillator.frequency.setValueAtTime(note.frequency, start);
    // Tiny linear attack avoids a click, exponential release makes the bell.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(note.peak, start + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.05);
  }
}

/**
 * Play the cue for one settled action. Returns whether a sound was actually
 * scheduled — false when the preference is off or no audio stack exists.
 * Never throws: sound is decoration, the toast itself is the confirmation.
 */
export function playToastCue(kind: ToastCueKind): boolean {
  if (!isToastSoundEnabled()) return false;
  const ctx = ensureContext();
  if (!ctx) return false;
  try {
    if (!ctx.state || ctx.state === 'running') {
      scheduleCue(ctx, toastCue(kind));
      return true;
    }
    // Suspended: no unlock gesture has landed yet (or the tab was parked).
    // Resume first and schedule only once genuinely running — notes scheduled
    // into a suspended context queue up and all blare at once when it wakes.
    void Promise.resolve(ctx.resume?.())
      .then(() => {
        if (ctx.state === 'running' && isToastSoundEnabled()) {
          scheduleCue(ctx, toastCue(kind));
        }
      })
      .catch(() => {
        // Context never woke — the toast itself is still the confirmation.
      });
    return true;
  } catch {
    return false;
  }
}

/** Test-only seam: swap the audio stack and the preference storage. */
export function __setToastSoundTestHooks(
  hooks: { contextFactory?: ContextFactory | null; storage?: StorageLike | null } = {},
): void {
  contextFactoryOverride = hooks.contextFactory ?? null;
  storageOverride = hooks.storage ?? null;
  sharedContext = null;
  prefListeners.clear();
}
