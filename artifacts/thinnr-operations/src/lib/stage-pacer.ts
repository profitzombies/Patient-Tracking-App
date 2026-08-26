/**
 * StagePacer — turns raw support-stream events into a paced narration.
 *
 * The server narrates real work over the SSE stream (searching → thinking →
 * formulating) and then streams the answer. On fast turns those events
 * arrive back-to-back — often in the SAME network read as the first content
 * chunk — so a client that renders text the moment it arrives would blink
 * the last label (or skip it entirely). This module owns the fix:
 *
 * - Every DISPLAYED stage label holds for a minimum beat (`minVisibleMs`)
 *   before the next label — or the answer text — may replace it.
 * - Incoming answer text is HELD while any displayed or queued stage is
 *   still owed its beat, then flushed in one append; once text has flushed,
 *   the gate is open and later deltas pass through immediately.
 * - `done` arriving while text is held defers finalization until the held
 *   text reaches the screen, so "streaming" never ends before the words
 *   show up.
 * - A timed fallback walks the same progression when the server sends no
 *   stage events (older API); the first real stage event disarms it.
 * - Interruptions never wait: `finish()` (Stop) fast-forwards — flushes held
 *   text, kills timers — and `cancel()` (error/clear/unmount) drops
 *   everything silently, so failure paths never sit on a fake beat.
 *
 * Pure module: the clock and timers are injectable, so the verify suite
 * drives it on a virtual clock and asserts exact label/flush timelines.
 * The React component just forwards stream callbacks in and applies
 * `onStageChange` / `onTextFlush` / `onFinalize` back out — keeping
 * "message.text is exactly what's on screen" true at all times.
 */
import type { SupportChatStage } from './support-chat';

export interface StagePacerCallbacks {
  /** Show this label next to the thinking dots. */
  onStageChange: (stage: SupportChatStage) => void;
  /** Append this text to the visible reply (single batched append). */
  onTextFlush: (text: string) => void;
  /** The stream's `done` has reached the screen — finalize the turn. */
  onFinalize: () => void;
}

export interface StagePacerOptions {
  /** Minimum ms each displayed label stays before text/next label. */
  minVisibleMs?: number;
  /** Fallback narration schedule for servers without stage events. */
  fallbackThinkingAtMs?: number;
  fallbackFormulatingAtMs?: number;
  /** Injectable time source and timers (virtual clock in tests). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const STAGE_MIN_VISIBLE_MS = 700;
export const FALLBACK_THINKING_AT_MS = 2600;
export const FALLBACK_FORMULATING_AT_MS = 14_000;

export class StagePacer {
  private readonly cb: StagePacerCallbacks;
  private readonly minVisibleMs: number;
  private readonly fallbackThinkingAtMs: number;
  private readonly fallbackFormulatingAtMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private displayed: SupportChatStage | null = null;
  private shownAt = 0;
  private queue: SupportChatStage[] = [];
  private held = '';
  private gateOpen = false;
  private donePending = false;
  private finished = false;
  private sawServerStage = false;
  private timer: unknown = null;
  private fallbackTimers: unknown[] = [];

  constructor(callbacks: StagePacerCallbacks, options: StagePacerOptions = {}) {
    this.cb = callbacks;
    this.minVisibleMs = options.minVisibleMs ?? STAGE_MIN_VISIBLE_MS;
    this.fallbackThinkingAtMs = options.fallbackThinkingAtMs ?? FALLBACK_THINKING_AT_MS;
    this.fallbackFormulatingAtMs = options.fallbackFormulatingAtMs ?? FALLBACK_FORMULATING_AT_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));
  }

  /** Begin a turn: show "searching" immediately and arm the fallback walk. */
  start(): void {
    this.displayed = 'searching';
    this.shownAt = this.now();
    this.cb.onStageChange('searching');
    this.fallbackTimers = [
      this.setTimer(() => this.fallbackStage('thinking'), this.fallbackThinkingAtMs),
      this.setTimer(() => this.fallbackStage('formulating'), this.fallbackFormulatingAtMs),
    ];
  }

  /** A real narration event from the server. */
  serverStage(stage: SupportChatStage): void {
    if (this.finished || this.gateOpen) return;
    if (!this.sawServerStage) {
      this.sawServerStage = true;
      this.disarmFallbacks();
    }
    this.enqueue(stage);
  }

  /** A chunk of answer text — held until every shown stage had its beat. */
  delta(text: string): void {
    if (this.finished) return;
    if (this.gateOpen) {
      this.cb.onTextFlush(text);
      return;
    }
    this.held += text;
    this.pump();
  }

  /** The stream completed; finalization waits for held text to land. */
  done(): void {
    if (this.finished) return;
    if (this.gateOpen) {
      this.finished = true;
      this.clearAllTimers();
      this.cb.onFinalize();
      return;
    }
    this.donePending = true;
    this.pump();
  }

  /**
   * Fast-forward for Stop: held text flushes NOW (the reader asked for the
   * current state, not an animation). Returns whether `done` had already
   * arrived — a caller about to mark the reply "stopped" must not, because
   * the model actually finished; onFinalize has fired in that case.
   */
  finish(): boolean {
    if (this.finished) return true;
    this.finished = true;
    const wasDone = this.donePending;
    this.clearAllTimers();
    if (this.held.length > 0) {
      const text = this.held;
      this.held = '';
      this.cb.onTextFlush(text);
    }
    if (wasDone) this.cb.onFinalize();
    return wasDone;
  }

  /** Silent teardown for error/clear/unmount: no flush, no callbacks. */
  cancel(): void {
    this.finished = true;
    this.held = '';
    this.donePending = false;
    this.clearAllTimers();
  }

  private fallbackStage(stage: SupportChatStage): void {
    if (this.finished || this.gateOpen || this.sawServerStage) return;
    this.enqueue(stage);
  }

  private enqueue(stage: SupportChatStage): void {
    const tail = this.queue.length > 0 ? this.queue[this.queue.length - 1] : this.displayed;
    if (tail === stage) return;
    this.queue.push(stage);
    this.pump();
  }

  /**
   * The single pacing walk. Whenever the displayed label has had its beat:
   * show the next queued label, or — with nothing left to narrate — open
   * the gate for held text / deferred done. Arms exactly one timer when
   * pending work must wait out a beat.
   */
  private pump(): void {
    if (this.finished || this.gateOpen) return;
    const remaining = this.shownAt + this.minVisibleMs - this.now();
    if (remaining > 0) {
      this.armTimer(remaining);
      return;
    }
    if (this.queue.length > 0) {
      this.displayed = this.queue.shift() as SupportChatStage;
      this.shownAt = this.now();
      this.cb.onStageChange(this.displayed);
      this.pump();
      return;
    }
    if (this.held.length > 0 || this.donePending) {
      this.gateOpen = true;
      this.disarmFallbacks();
      if (this.timer !== null) {
        this.clearTimer(this.timer);
        this.timer = null;
      }
      if (this.held.length > 0) {
        const text = this.held;
        this.held = '';
        this.cb.onTextFlush(text);
      }
      if (this.donePending) {
        this.donePending = false;
        this.finished = true;
        this.cb.onFinalize();
      }
    }
    // Nothing pending: stay idle; the next event wakes the walk.
  }

  private armTimer(ms: number): void {
    if (this.queue.length === 0 && this.held.length === 0 && !this.donePending) return;
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pump();
    }, ms);
  }

  private disarmFallbacks(): void {
    for (const handle of this.fallbackTimers) this.clearTimer(handle);
    this.fallbackTimers = [];
  }

  private clearAllTimers(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.disarmFallbacks();
  }
}
