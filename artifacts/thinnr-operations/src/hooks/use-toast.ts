/**
 * Toast store for the operations portal.
 *
 * Extends the stock shadcn pattern with the portal's notification layer:
 *  - Variants carry sound for free: success toasts ring a soft bell ding and
 *    destructive toasts play a lower failure tone (lib/toast-sound.ts; a
 *    persisted per-browser preference silences both).
 *  - progressToast() drives the bottom-right progress variant — a live bar
 *    with done/failed end states — for long-running work like uploads.
 *  - Up to three toasts stack politely; eviction never drops a toast whose
 *    progress is still active.
 *  - Progress end states are voiced through a dedicated polite live region
 *    in the Toaster, because Radix only announces a toast when it first
 *    opens, never when it morphs in place.
 */
import * as React from 'react';
import type { ToastActionElement, ToastProps } from '@/components/ui/toast';
import { playToastCue } from '@/lib/toast-sound';

const TOAST_LIMIT = 3;
let toastRemoveDelay = 1200;
/** Failures linger past the 5s provider default so they can't be missed. */
const DESTRUCTIVE_TOAST_DURATION = 8000;
/** How long a finished progress toast stays up before dismissing itself. */
let progressDoneLinger = 4000;

/**
 * Test-only: shrink the real-time timers so suites don't sit through
 * multi-second waits (long sleeps have proven abort-prone under parallel
 * validation load). Call with no argument to restore production timing.
 */
export function __setToastTimingForTests(timing?: {
  removeDelayMs?: number;
  progressLingerMs?: number;
}) {
  toastRemoveDelay = timing?.removeDelayMs ?? 1200;
  progressDoneLinger = timing?.progressLingerMs ?? 4000;
}

export interface ToastProgress {
  /** Whole-number percent, 0–100. */
  value: number;
  state: 'active' | 'done' | 'failed';
}

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  progress?: ToastProgress;
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type Action =
  | { type: 'ADD_TOAST'; toast: ToasterToast }
  | { type: 'UPDATE_TOAST'; toast: Partial<ToasterToast> }
  | { type: 'DISMISS_TOAST'; toastId?: ToasterToast['id'] }
  | { type: 'REMOVE_TOAST'; toastId?: ToasterToast['id'] }
  | { type: 'ANNOUNCE'; serial: number; message: string };

interface State {
  toasts: ToasterToast[];
  /**
   * Latest progress end-state message for the Toaster's polite live region.
   * The serial lets consecutive identical messages still re-announce.
   */
  announcement: { serial: number; message: string } | null;
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: 'REMOVE_TOAST',
      toastId: toastId,
    });
  }, toastRemoveDelay);

  toastTimeouts.set(toastId, timeout);
};

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST': {
      const next = [action.toast, ...state.toasts];
      if (next.length <= TOAST_LIMIT) return { ...state, toasts: next };
      // Evict oldest first, but never a toast whose progress is still
      // active — a live upload bar must survive unrelated confirmations.
      let excess = next.length - TOAST_LIMIT;
      const kept: ToasterToast[] = [];
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index]!;
        if (excess > 0 && candidate.progress?.state !== 'active') {
          excess -= 1;
          continue;
        }
        kept.unshift(candidate);
      }
      return { ...state, toasts: kept };
    }

    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t,
        ),
      };

    case 'DISMISS_TOAST': {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t,
        ),
      };
    }
    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };

    case 'ANNOUNCE':
      return {
        ...state,
        announcement: { serial: action.serial, message: action.message },
      };
  }
};

const listeners: Array<(state: State) => void> = [];

let memoryState: State = { toasts: [], announcement: null };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

let announceSerial = 0;

/** Push a message through the Toaster's polite live region exactly once. */
function announce(message: string) {
  announceSerial += 1;
  dispatch({ type: 'ANNOUNCE', serial: announceSerial, message });
}

function announcementText(title: string, description?: React.ReactNode): string {
  return typeof description === 'string' && description.trim().length > 0
    ? `${title}. ${description}`
    : title;
}

type Toast = Omit<ToasterToast, 'id'>;

function toast({ ...props }: Toast) {
  const id = genId();

  const update = (props: ToasterToast) =>
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { ...props, id },
    });
  const dismiss = () => dispatch({ type: 'DISMISS_TOAST', toastId: id });

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      duration:
        props.variant === 'destructive' ? DESTRUCTIVE_TOAST_DURATION : undefined,
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  // Sound rides the variant so every caller gets it for free; the persisted
  // on/off preference is enforced inside playToastCue. Default-variant
  // toasts stay silent — they're informational, not action outcomes.
  if (props.variant === 'success') playToastCue('success');
  else if (props.variant === 'destructive') playToastCue('failure');

  return {
    id: id,
    dismiss,
    update,
  };
}

const progressDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleProgressDismiss(toastId: string) {
  const existing = progressDismissTimers.get(toastId);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    progressDismissTimers.delete(toastId);
    dispatch({ type: 'DISMISS_TOAST', toastId });
  }, progressDoneLinger);
  progressDismissTimers.set(toastId, timeout);
}

export interface ProgressToastEnd {
  title?: string;
  description?: React.ReactNode;
}

export interface ProgressToastHandle {
  id: string;
  /** Move the live bar; values clamp to 0–100 and round to whole percent. */
  setProgress: (value: number) => void;
  /** Finish: full bar, success styling, bell ding, self-dismiss shortly. */
  done: (end?: ProgressToastEnd) => void;
  /** Fail: destructive styling, failure tone, stays until dismissed. */
  fail: (end?: ProgressToastEnd) => void;
  dismiss: () => void;
}

/**
 * Bottom-right progress toast for long-running work (uploads, batch jobs).
 * The handle drives the bar; done()/fail() settle it exactly once — later
 * calls are ignored, so racing callbacks can't double-ring or flip states.
 */
function progressToast(options: {
  title: string;
  description?: React.ReactNode;
}): ProgressToastHandle {
  const id = genId();
  let settled = false;
  let lastValue = 0;

  const dismiss = () => dispatch({ type: 'DISMISS_TOAST', toastId: id });

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      id,
      title: options.title,
      description: options.description,
      progress: { value: 0, state: 'active' },
      // Stays up while the work runs; done()/fail() decide how it leaves.
      duration: Infinity,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  const setProgress = (value: number) => {
    if (settled || !Number.isFinite(value)) return;
    lastValue = Math.min(100, Math.max(0, Math.round(value)));
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { id, progress: { value: lastValue, state: 'active' } },
    });
  };

  const done: ProgressToastHandle['done'] = (end) => {
    if (settled) return;
    settled = true;
    const title = end?.title ?? options.title;
    const description = end?.description ?? options.description;
    dispatch({
      type: 'UPDATE_TOAST',
      toast: {
        id,
        variant: 'success',
        title,
        description,
        progress: { value: 100, state: 'done' },
      },
    });
    announce(announcementText(title, description));
    playToastCue('success');
    scheduleProgressDismiss(id);
  };

  const fail: ProgressToastHandle['fail'] = (end) => {
    if (settled) return;
    settled = true;
    const title = end?.title ?? `${options.title} — failed`;
    dispatch({
      type: 'UPDATE_TOAST',
      toast: {
        id,
        variant: 'destructive',
        title,
        description: end?.description,
        progress: { value: lastValue, state: 'failed' },
      },
    });
    announce(announcementText(title, end?.description));
    playToastCue('failure');
    // Failed work stays on screen until the admin closes it.
  };

  return { id, setProgress, done, fail, dismiss };
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, [state]);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: 'DISMISS_TOAST', toastId }),
  };
}

/** Test-only: clear every toast, pending timer, and announcement. */
function __resetToastStoreForTests() {
  for (const timeout of toastTimeouts.values()) clearTimeout(timeout);
  toastTimeouts.clear();
  for (const timeout of progressDismissTimers.values()) clearTimeout(timeout);
  progressDismissTimers.clear();
  memoryState = { toasts: [], announcement: null };
  listeners.forEach((listener) => listener(memoryState));
}

/** Test-only: snapshot of the store for the verification suite. */
function __getToastStateForTests(): State {
  return memoryState;
}

export {
  useToast,
  toast,
  progressToast,
  __resetToastStoreForTests,
  __getToastStateForTests,
};
