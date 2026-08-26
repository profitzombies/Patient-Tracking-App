/**
 * Node stand-in for expo-router for the meal-photo suite: records
 * navigation calls (the camera handoff pushes /food-camera; confirming a
 * photo away from the chat pushes /coach-chat) and lets scenarios pick the
 * active pathname.
 */
export interface RouterCall {
  method: 'push' | 'replace' | 'back';
  target: string;
}

export const routerCalls: RouterCall[] = [];

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

/** Active pathname reported by usePathname; set per scenario. */
export const routerState = { pathname: '/diary' };

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

export function Redirect(_props: { href: unknown }): null {
  return null;
}
