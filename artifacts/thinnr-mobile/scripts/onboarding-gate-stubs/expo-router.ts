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
  /** Object hrefs' params (e.g. a login notice), so suites can assert the wording that travelled. */
  params?: Record<string, unknown>;
}

export const routerCalls: RouterCall[] = [];
const targetOf = (href: unknown): string =>
  href && typeof href === 'object' && 'pathname' in href
    ? String((href as { pathname: unknown }).pathname)
    : String(href);
const paramsOf = (href: unknown): Record<string, unknown> | undefined =>
  href && typeof href === 'object' && 'params' in href && (href as { params: unknown }).params && typeof (href as { params: unknown }).params === 'object'
    ? ((href as { params: Record<string, unknown> }).params)
    : undefined;

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

export const router = {
  push(href: unknown): void {
    routerCalls.push({ method: 'push', target: targetOf(href), params: paramsOf(href) });
  },
  replace(href: unknown): void {
    routerCalls.push({ method: 'replace', target: targetOf(href), params: paramsOf(href) });
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

/** Suites set this to simulate a deep link such as /billing?subscription=sub-1&action=skip. */
export let searchParams: Record<string, string> = {};
export function setSearchParams(next: Record<string, string>): void {
  searchParams = next;
}

export function useLocalSearchParams<T extends Record<string, unknown>>(): T {
  return searchParams as T;
}

export function usePathname(): string {
  return '/';
}
