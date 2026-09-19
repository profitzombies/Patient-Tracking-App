import { useCallback, useEffect, useRef, useState } from 'react';

export type IdleState = 'active' | 'warning';

const WARNING_SECONDS = 60;
const ACTIVITY_THROTTLE_MS = 1_000;
const CHANNEL_NAME = 'thinnr-ops-idle';
export const INACTIVITY_SIGN_OUT_REASON_KEY = 'thinnr-ops-signout-reason';

type IdleMessage =
  | { type: 'activity'; at: number }
  | { type: 'signed-out' };

interface UseIdleTimeoutOptions {
  enabled: boolean;
  idleTimeoutMinutes: number;
  signOut: () => void;
}

export function useIdleTimeout({
  enabled,
  idleTimeoutMinutes,
  signOut,
}: UseIdleTimeoutOptions) {
  const [idleState, setIdleState] = useState<IdleState>('active');
  const [secondsLeft, setSecondsLeft] = useState(WARNING_SECONDS);
  const deadlineRef = useRef(0);
  const warningRef = useRef(false);
  const signedOutRef = useRef(false);
  const lastActivityRef = useRef(0);
  const lastBroadcastRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (checkTimerRef.current !== null) clearTimeout(checkTimerRef.current);
    if (countdownTimerRef.current !== null) clearInterval(countdownTimerRef.current);
    checkTimerRef.current = null;
    countdownTimerRef.current = null;
  }, []);

  const expire = useCallback((broadcast: boolean) => {
    if (signedOutRef.current) return;
    signedOutRef.current = true;
    clearTimers();
    try {
      window.sessionStorage.setItem(INACTIVITY_SIGN_OUT_REASON_KEY, 'inactivity');
    } catch {
      // Sign-out must still succeed when storage is unavailable.
    }
    if (broadcast) channelRef.current?.postMessage({ type: 'signed-out' } satisfies IdleMessage);
    signOut();
  }, [clearTimers, signOut]);

  const updateFromDeadline = useCallback(() => {
    if (!enabled || signedOutRef.current) return;
    const remainingMs = deadlineRef.current - Date.now();
    if (remainingMs <= 0) {
      expire(true);
      return;
    }

    if (remainingMs <= WARNING_SECONDS * 1_000) {
      const nextSeconds = Math.max(1, Math.ceil(remainingMs / 1_000));
      if (!warningRef.current) {
        warningRef.current = true;
        setIdleState('warning');
      }
      setSecondsLeft((current) => current === nextSeconds ? current : nextSeconds);
    }
  }, [enabled, expire]);

  const schedule = useCallback(() => {
    clearTimers();
    if (!enabled || signedOutRef.current) return;
    const warningAt = deadlineRef.current - WARNING_SECONDS * 1_000;
    const delay = Math.max(0, warningAt - Date.now());
    checkTimerRef.current = setTimeout(() => {
      updateFromDeadline();
      countdownTimerRef.current = setInterval(updateFromDeadline, 1_000);
    }, delay);
  }, [clearTimers, enabled, updateFromDeadline]);

  const resetDeadline = useCallback((at = Date.now(), broadcast = true) => {
    if (!enabled || signedOutRef.current) return;
    deadlineRef.current = at + idleTimeoutMinutes * 60 * 1_000;
    if (warningRef.current) {
      warningRef.current = false;
      setIdleState('active');
    }
    setSecondsLeft(WARNING_SECONDS);
    schedule();

    if (broadcast && at - lastBroadcastRef.current >= ACTIVITY_THROTTLE_MS) {
      lastBroadcastRef.current = at;
      channelRef.current?.postMessage({ type: 'activity', at } satisfies IdleMessage);
    }
  }, [enabled, idleTimeoutMinutes, schedule]);

  const dismissIdleWarning = useCallback(() => {
    lastActivityRef.current = Date.now();
    resetDeadline(lastActivityRef.current);
  }, [resetDeadline]);

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      warningRef.current = false;
      signedOutRef.current = false;
      setIdleState('active');
      setSecondsLeft(WARNING_SECONDS);
      return;
    }

    signedOutRef.current = false;
    const now = Date.now();
    lastActivityRef.current = now;
    deadlineRef.current = now + idleTimeoutMinutes * 60 * 1_000;

    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<IdleMessage>) => {
        const message = event.data;
        if (message?.type === 'activity' && Number.isFinite(message.at)) {
          lastActivityRef.current = message.at;
          resetDeadline(message.at, false);
        } else if (message?.type === 'signed-out') {
          expire(false);
        }
      };
    }

    const handleActivity = () => {
      const activityAt = Date.now();
      if (!warningRef.current && activityAt - lastActivityRef.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityRef.current = activityAt;
      resetDeadline(activityAt);
    };
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() >= deadlineRef.current) {
        expire(true);
      } else {
        handleActivity();
      }
    };
    const activityEvents: Array<keyof WindowEventMap> = [
      'pointerdown',
      'pointermove',
      'keydown',
      'wheel',
      'touchstart',
      'scroll',
    ];
    const listenerOptions: AddEventListenerOptions = { capture: true, passive: true };
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, handleActivity, listenerOptions);
    }
    document.addEventListener('visibilitychange', handleVisibility, listenerOptions);
    schedule();

    return () => {
      clearTimers();
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, handleActivity, listenerOptions);
      }
      document.removeEventListener('visibilitychange', handleVisibility, listenerOptions);
      channelRef.current?.close();
      channelRef.current = null;
      warningRef.current = false;
    };
  }, [clearTimers, enabled, expire, idleTimeoutMinutes, resetDeadline, schedule]);

  return { idleState, secondsLeft, dismissIdleWarning };
}