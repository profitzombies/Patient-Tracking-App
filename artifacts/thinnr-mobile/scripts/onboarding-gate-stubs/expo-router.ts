/**
 * Node stand-in for expo-router (see tsconfig.onboarding-gate.json `paths`).
 *
 * The suite reads `routerCalls` to prove a blocked Next never navigates and
 * that a valid Next advances with exactly one push to the right step. Both
 * the components (importing 'expo-router') and the suite (importing this
 * file relatively) resolve to this same module instance.
 */
export type Href = string;

export interface RouterCall {
  method: 'push' | 'replace' | 'back';
  target: string;
}

export const routerCalls: RouterCall[] = [];
const targetOf = (href: unknown): string =>
  href && typeof href === 'object' && 'pathname' in href
    ? String((href as { pathname: unknown }).pathname)
    : String(href);

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

export const router = {
  push(href: unknown): void {
    routerCalls.push({ method: 'push', target: targetOf(href) });
  },
  replace(href: unknown): void {
    routerCalls.push({ method: 'replace', target: targetOf(href) });
  },
  back(): void {
    routerCalls.push({ method: 'back', target: '' });
  },
  canGoBack(): boolean {
    return false;
  },
};

export function Redirect(_props: { href: string }) {
  return null;
}

export function useLocalSearchParams<T extends Record<string, unknown>>(): T {
  return {} as T;
}

export function usePathname(): string {
  return '/';
}
