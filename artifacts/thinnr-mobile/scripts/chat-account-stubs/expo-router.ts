/**
 * Node stand-in for expo-router used by the chat-account suite: everything
 * the shared onboarding-gate stub provides, plus the hooks the support-chat
 * screen reads. `usePathname` reports '/' so the screen's staff redirect
 * (which only keys on the literal '/support-chat' path) stays out of the
 * way — the suite drives persistence, not the persona gate.
 */
export * from '../onboarding-gate-stubs/expo-router';
import { router } from '../onboarding-gate-stubs/expo-router';

export function useRouter() {
  return router;
}

export function usePathname(): string {
  return '/';
}

/** The coach screen reads its entry params; the suite opens it bare. */
export function useLocalSearchParams(): Record<string, string | undefined> {
  return {};
}
