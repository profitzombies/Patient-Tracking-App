/**
 * Node stand-in for expo-router for the barcode-scan suite: records
 * navigation calls (Done/Cancel go back; the miss card replaces to
 * /create-food), reports a scenario-controlled pathname AND search params
 * (the screen reads `{ date, meal }` from useLocalSearchParams), and
 * captures Redirect renders so the persona gate is assertable.
 */
export interface RouterCall {
  method: 'push' | 'replace' | 'back';
  target: string;
}

export const routerCalls: RouterCall[] = [];

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

/** Hrefs every rendered <Redirect> pointed at (the persona/staff gates). */
export const redirects: string[] = [];

export function clearRedirects(): void {
  redirects.length = 0;
}

/** Active pathname and search params reported to the screen; set per scenario. */
export const routerState = {
  pathname: '/barcode-scan',
  params: {} as Record<string, string>,
};

const routerApi = {
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
    return true;
  },
};

export const router = routerApi;

export function useRouter(): typeof routerApi {
  return routerApi;
}

export function usePathname(): string {
  return routerState.pathname;
}

export function useLocalSearchParams<T = Record<string, string>>(): T {
  return routerState.params as T;
}

export function Redirect(props: { href: unknown }): null {
  redirects.push(String(props.href));
  return null;
}
