/**
 * Node stand-in for expo-router used by the chat-account suite: everything
 * the shared onboarding-gate stub provides, plus the hooks the support-chat
 * screen reads. `usePathname` reports '/' so the screen's staff redirect
 * (which only keys on the literal '/support-chat' path) stays out of the
 * way — the suite drives persistence, not the persona gate.
 */
export * from '../onboarding-gate-stubs/expo-router';
import { useEffect } from 'react';
import { router } from '../onboarding-gate-stubs/expo-router';

export function useRouter() {
  return router;
}

export function usePathname(): string {
  return '/';
}

export function useFocusEffect(effect: () => void | (() => void)): void {
  useEffect(effect, [effect]);
}

let params: Record<string, string | undefined> = {};

export function setChatAccountParams(next: Record<string, string | undefined>): void {
  params = next;
}

/** The coach screen reads its entry params; tests set these before mounting. */
export function useLocalSearchParams<T = Record<string, string | undefined>>(): T {
  return params as T;
}
