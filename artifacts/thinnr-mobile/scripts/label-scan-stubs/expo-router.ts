/**
 * Node stand-in for expo-router for the label-scan suite.
 *
 * Beyond the router-call capture the other suites use, create-food needs
 * search params (edit mode rides an `id` param), the active pathname (the
 * persona gate checks it), and a Redirect stand-in that records where a
 * non-patient persona would have been sent instead of navigating.
 */
export type Href = string;

export interface RouterCall {
  method: 'push' | 'replace' | 'back';
  target: string;
}

export const routerCalls: RouterCall[] = [];

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

export const router = {
  push(href: unknown): void {
    routerCalls.push({ method: 'push', target: String(href) });
  },
  replace(href: unknown): void {
    routerCalls.push({ method: 'replace', target: String(href) });
  },
  back(): void {
    routerCalls.push({ method: 'back', target: '' });
  },
  canGoBack(): boolean {
    return false;
  },
};

/** Params returned by useLocalSearchParams; set per render via setParams. */
let currentParams: Record<string, string> = {};

export function setParams(params: Record<string, string>): void {
  currentParams = params;
}

export function useLocalSearchParams<T = Record<string, string>>(): T {
  return currentParams as T;
}

export function usePathname(): string {
  return '/create-food';
}

/** Redirect targets recorded at render time (the stub never navigates). */
export const redirects: string[] = [];

export function clearRedirects(): void {
  redirects.length = 0;
}

export function Redirect({ href }: { href: unknown }): null {
  redirects.push(String(href));
  return null;
}
