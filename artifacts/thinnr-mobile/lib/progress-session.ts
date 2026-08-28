/**
 * Guided progress-photo session — pure domain logic.
 *
 * The patient props their phone on the floor, steps back about six feet,
 * and the app walks them through three photos (front, side, back) with a
 * spoken prompt, a giant on-screen countdown, and an automatic shutter at
 * zero. No AI is involved anywhere in this flow: the post-capture quality
 * checks live in lib/photo-analysis.ts and are plain image math.
 *
 * Everything here is deliberately free of React/native imports so the
 * verify suite can drive a whole session (including per-angle reshoots)
 * as fast as the event loop allows via an injected timing config.
 */

export type SessionAngle = 'front' | 'side' | 'back';

export const SESSION_ANGLES: readonly SessionAngle[] = ['front', 'side', 'back'];

export interface AngleMeta {
  /** Giant label over the live preview — legible from six feet away. */
  title: string;
  /** Spoken out loud when this angle's countdown starts. */
  spoken: string;
  /** One-line positioning reminder under the big label. */
  guidance: string;
}

export const ANGLE_META: Record<SessionAngle, AngleMeta> = {
  front: {
    title: 'FRONT',
    spoken: 'Front photo. Face the camera.',
    guidance: 'Face the camera, arms relaxed at your sides.',
  },
  side: {
    title: 'SIDE',
    spoken: 'Side photo. Turn to your side.',
    guidance: 'Turn so your side faces the camera. Stand tall.',
  },
  back: {
    title: 'BACK',
    spoken: 'Back photo. Turn away from the camera.',
    guidance: 'Turn your back to the camera, arms relaxed.',
  },
};

/** Seconds the patient gets to walk back / turn before each shot. */
export const COUNTDOWN_SECONDS = 7;

/**
 * Timing knobs, injectable so tests can run a full session in milliseconds
 * while the app ships the real seven-second cadence.
 */
export interface SessionTimingConfig {
  countdownSeconds: number;
  tickMs: number;
}

export const DEFAULT_TIMING: SessionTimingConfig = {
  countdownSeconds: COUNTDOWN_SECONDS,
  tickMs: 1000,
};

/** One captured shot, kept on-device until the patient saves. */
export interface SessionShot {
  angle: SessionAngle;
  /** Local uri (file:// on device, data: on web). */
  uri: string;
  width: number;
  height: number;
  /**
   * Small grayscale-analysis JPEG (base64, no data: prefix) produced right
   * after capture — the input to the no-AI quality checks.
   */
  analysisBase64?: string;
}

export type SessionPhase =
  | { kind: 'setup' }
  | {
      kind: 'countdown';
      queue: readonly SessionAngle[];
      index: number;
      secondsLeft: number;
    }
  | { kind: 'capturing'; queue: readonly SessionAngle[]; index: number }
  | { kind: 'review' }
  | { kind: 'saving'; done: number; total: number }
  | { kind: 'saved' };

export type SessionEvent =
  | { type: 'BEGIN'; queue: readonly SessionAngle[]; countdownSeconds: number }
  | { type: 'TICK' }
  | { type: 'SHOT_DONE'; countdownSeconds: number }
  | { type: 'SAVE_START'; total: number }
  | { type: 'SAVE_PROGRESS' }
  | { type: 'SAVE_DONE' }
  | { type: 'SAVE_FAILED' };

/**
 * Phase transitions for the whole session. The reducer is intentionally
 * blind to timers, cameras, and uploads — the surface owns those and feeds
 * events in; tests feed the same events directly.
 *
 * Countdown semantics: BEGIN enters `countdown` at the configured seconds;
 * each TICK decrements; the TICK taken at 1 moves to `capturing` (so a
 * 7-second config shows 7…1 and fires the shutter one tick later).
 * SHOT_DONE advances to the next queued angle's countdown, or to review
 * when the queue is exhausted — capture FAILURES also emit SHOT_DONE (the
 * missing shot is flagged at review), so one bad shutter never wedges the
 * run.
 */
export function sessionReducer(phase: SessionPhase, event: SessionEvent): SessionPhase {
  switch (event.type) {
    case 'BEGIN':
      if (event.queue.length === 0) return phase;
      return {
        kind: 'countdown',
        queue: event.queue,
        index: 0,
        secondsLeft: Math.max(1, Math.round(event.countdownSeconds)),
      };
    case 'TICK': {
      if (phase.kind !== 'countdown') return phase;
      if (phase.secondsLeft <= 1) {
        return { kind: 'capturing', queue: phase.queue, index: phase.index };
      }
      return { ...phase, secondsLeft: phase.secondsLeft - 1 };
    }
    case 'SHOT_DONE': {
      if (phase.kind !== 'capturing') return phase;
      const nextIndex = phase.index + 1;
      if (nextIndex < phase.queue.length) {
        return {
          kind: 'countdown',
          queue: phase.queue,
          index: nextIndex,
          secondsLeft: Math.max(1, Math.round(event.countdownSeconds)),
        };
      }
      return { kind: 'review' };
    }
    case 'SAVE_START':
      if (phase.kind !== 'review') return phase;
      return { kind: 'saving', done: 0, total: event.total };
    case 'SAVE_PROGRESS':
      if (phase.kind !== 'saving') return phase;
      return { ...phase, done: Math.min(phase.total, phase.done + 1) };
    case 'SAVE_DONE':
      if (phase.kind !== 'saving') return phase;
      return { kind: 'saved' };
    case 'SAVE_FAILED':
      // Shots stay on device; the surface shows the retryable error box.
      if (phase.kind !== 'saving') return phase;
      return { kind: 'review' };
    default:
      return phase;
  }
}

/** The angle currently being counted down / captured, if any. */
export function activeAngle(phase: SessionPhase): SessionAngle | null {
  if (phase.kind === 'countdown' || phase.kind === 'capturing') {
    return phase.queue[phase.index] ?? null;
  }
  return null;
}

/**
 * Angles ticked for reshoot, in canonical front→side→back order regardless
 * of tap order — the retake run always walks the same direction the first
 * run did.
 */
export function reshootQueue(selected: Partial<Record<SessionAngle, boolean>>): SessionAngle[] {
  return SESSION_ANGLES.filter(angle => selected[angle] === true);
}

/** "Week 18 · Front" — the grid label for a session photo. */
export function buildPhotoLabel(weekNumber: number, angle: SessionAngle): string {
  const title = ANGLE_META[angle].title;
  const pretty = title.charAt(0) + title.slice(1).toLowerCase();
  return `Week ${weekNumber} · ${pretty}`;
}
