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

export function Redirect(_props: { href: string }) {
  return null;
}
