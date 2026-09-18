/**
 * Polite polling: a `refetchInterval` that pauses entirely while the browser
 * tab is hidden and slows down once nobody has touched the page for a while.
 *
 * Why: staff leave dashboards open all day. Every fixed-interval poll on
 * every open tab lands on the same server that serves patients, whether or
 * not anyone is looking. TanStack Query re-evaluates a function interval
 * after each fetch and restarts timers on window focus, so returning `false`
 * while hidden stops the timer, and the focus refetch (which every query
 * here keeps on) restarts it when the tab comes back.
 *
 * Idle is tracked once per page from real input events; the module installs
 * its listeners lazily so React-free scripts and the server never touch
 * `document`.
 */

/** No input for this long counts as idle (3 minutes). */
export const IDLE_AFTER_MS = 3 * 60_000;
/** Deep idle: no input for this long (15 minutes). */
export const DEEP_IDLE_AFTER_MS = 15 * 60_000;
export const IDLE_MULTIPLIER = 2;
export const DEEP_IDLE_MULTIPLIER = 4;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'] as const;
/** Mouse moves are frequent; sampling them this often is plenty. */
const MOVE_SAMPLE_MS = 5_000;

let lastActivityAt = 0;
let lastMoveSampleAt = 0;
let installed = false;

function markActive(now = Date.now()): void {
  lastActivityAt = now;
}

function install(): void {
  if (installed) return;
  installed = true;
  markActive();
  // Test harnesses stub a partial document/window; treat them as a page
  // nobody interacts with rather than throwing inside a refetch decision.
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (typeof window.addEventListener !== 'function' || typeof document.addEventListener !== 'function') return;
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, () => markActive(), { passive: true, capture: true });
  window.addEventListener('pointermove', () => {
    const now = Date.now();
    if (now - lastMoveSampleAt < MOVE_SAMPLE_MS) return;
    lastMoveSampleAt = now;
    markActive(now);
  }, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    // Coming back to the tab is activity in its own right.
    if (document.visibilityState === 'visible') markActive();
  });
}

/** True when the page is in a hidden tab or minimized window. */
export function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Milliseconds since the last user input on this page (0 before any is seen). */
export function idleFor(now = Date.now()): number {
  install();
  return lastActivityAt === 0 ? 0 : Math.max(0, now - lastActivityAt);
}

/** The factor the current idle stretch applies to a base interval. */
export function idleMultiplier(now = Date.now()): number {
  const idle = idleFor(now);
  if (idle >= DEEP_IDLE_AFTER_MS) return DEEP_IDLE_MULTIPLIER;
  if (idle >= IDLE_AFTER_MS) return IDLE_MULTIPLIER;
  return 1;
}

/**
 * Turns a base cadence into a polite one: `false` while the tab is hidden,
 * the base while someone is active, and a multiple of it once they go idle.
 * `false` and `undefined` pass straight through so callers keep their own
 * "nothing pending, stop polling" decisions.
 */
export function politeInterval(base: number | false | undefined, now = Date.now()): number | false | undefined {
  if (base === false || base === undefined) return base;
  if (pageHidden()) return false;
  return base * idleMultiplier(now);
}

/**
 * A fixed cadence as a polite `refetchInterval`. Query-driven cadences wrap
 * their own decision in `politeInterval` instead, which keeps TanStack's
 * query typing at the call site.
 */
export function politeRefetchInterval(base: number): () => number | false {
  return () => politeInterval(base) as number | false;
}

/** Test seam: pretend the last input happened at `at` (epoch ms). */
export function __setLastActivityForTests(at: number): void {
  install();
  lastActivityAt = at;
}
