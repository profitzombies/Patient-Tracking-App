/**
 * Node stand-in for expo-router used by the provider-training suite (see
 * tsconfig.provider-training.json `paths`).
 *
 * The training screens read route params and the pathname, navigate through
 * the shared `router`, and gate deep links behind <Redirect>. The stub keeps
 * all of that inspectable: the suite sets params/pathname before rendering
 * and asserts on `routerLog` afterwards. It shares this module instance with
 * the components under test via the same 'expo-router' specifier.
 */
import React from 'react';

export type Href = string;

export interface RouterCall {
  method: 'push' | 'replace' | 'back';
  target: string;
}

export const routerLog: RouterCall[] = [];

export const router = {
  push(href: unknown): void {
    routerLog.push({ method: 'push', target: String(href) });
  },
  replace(href: unknown): void {
    routerLog.push({ method: 'replace', target: String(href) });
  },
  back(): void {
    routerLog.push({ method: 'back', target: '' });
  },
  canGoBack(): boolean {
    return true;
  },
};

export function useRouter() {
  return router;
}

let currentParams: Record<string, string> = {};
let currentPathname = '/';

export function setSearchParams(params: Record<string, string>): void {
  currentParams = params;
}

export function setPathname(pathname: string): void {
  currentPathname = pathname;
}

export function useLocalSearchParams<T = Record<string, string>>(): T {
  return currentParams as T;
}

export function usePathname(): string {
  return currentPathname;
}

export function Redirect(props: { href: string }) {
  return React.createElement('Redirect', props);
}
