/**
 * Reachability signal for the offline write queue.
 *
 * "Online" here is a hint, not a guarantee: the queue still treats every
 * request failure on its own merits. What the hint buys is (a) not burning
 * retry attempts while the device knows it has no network, and (b) kicking
 * the drain the moment connectivity returns rather than waiting for the next
 * backoff timer.
 *
 * Web reads navigator.onLine plus the online/offline events. Native uses
 * @react-native-community/netinfo, loaded lazily so the Node suites (which
 * stub react-native with Platform.OS = 'web') never touch the native module.
 * `setConnectivityOverride` lets those suites script offline periods.
 */

import { Platform } from 'react-native';

type Listener = (online: boolean) => void;

let override: boolean | null = null;
const listeners = new Set<Listener>();
let lastKnown: boolean | null = null;
let nativeUnsubscribe: (() => void) | null = null;

function emit(online: boolean) {
  for (const listener of [...listeners]) listener(online);
}

function readWebOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return typeof nav?.onLine === 'boolean' ? nav.onLine : true;
}

function ensureNativeSubscription() {
  if (nativeUnsubscribe || Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const NetInfo = require('@react-native-community/netinfo') as {
      addEventListener: (
        handler: (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void,
      ) => () => void;
    };
    nativeUnsubscribe = NetInfo.addEventListener(state => {
      // isInternetReachable is null while netinfo is still probing; only a
      // definite false counts as offline so a slow probe never parks the queue.
      const online = state.isConnected !== false && state.isInternetReachable !== false;
      if (lastKnown === online) return;
      lastKnown = online;
      if (override === null) emit(online);
    });
  } catch {
    // Module unavailable (e.g. a web bundle that reached this branch) —
    // stay optimistic; request failures still drive the backoff.
    nativeUnsubscribe = () => undefined;
  }
}

/** Current best guess. Optimistic when nothing is known yet. */
export function isOnline(): boolean {
  if (override !== null) return override;
  if (Platform.OS === 'web') return readWebOnline();
  ensureNativeSubscription();
  return lastKnown ?? true;
}

/** Subscribes to reachability changes; returns the unsubscribe. */
export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  if (Platform.OS === 'web') {
    const target = globalThis as unknown as {
      addEventListener?: (type: string, cb: () => void) => void;
      removeEventListener?: (type: string, cb: () => void) => void;
    };
    const onOnline = () => {
      if (override === null) listener(true);
    };
    const onOffline = () => {
      if (override === null) listener(false);
    };
    target.addEventListener?.('online', onOnline);
    target.addEventListener?.('offline', onOffline);
    return () => {
      listeners.delete(listener);
      target.removeEventListener?.('online', onOnline);
      target.removeEventListener?.('offline', onOffline);
    };
  }
  ensureNativeSubscription();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test seam: pins the signal (true/false) or releases it (null). Emits the
 * change to subscribers exactly like a real transition would — unless
 * `silent`, which models the OS flipping reachability while no listener
 * heard it (events dropped in the background), the case the foreground
 * re-check exists for.
 */
export function setConnectivityOverride(value: boolean | null, options?: { silent?: boolean }): void {
  const before = isOnline();
  override = value;
  const after = isOnline();
  if (before !== after && !options?.silent) emit(after);
}
