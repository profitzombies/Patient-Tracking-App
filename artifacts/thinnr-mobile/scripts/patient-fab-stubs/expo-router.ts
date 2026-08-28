/**
 * Node stand-in for expo-router (see tsconfig.patient-fab.json `paths`).
 *
 * Unlike the older suites' stubs, `target` keeps the RAW href — the FAB's
 * meal-photo row pushes an OBJECT ({ pathname, params }) and the suite
 * asserts the params ride along. Both the components (importing
 * 'expo-router') and the suite (importing this file relatively) resolve to
 * this same module instance.
 */
import React from 'react';

export type Href = unknown;

export interface RouterCall {
  method: 'push' | 'replace' | 'navigate' | 'back';
  target: unknown;
}

export const routerCalls: RouterCall[] = [];

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

export const router = {
  push(href: unknown): void {
    routerCalls.push({ method: 'push', target: href });
  },
  navigate(href: unknown): void {
    routerCalls.push({ method: 'navigate', target: href });
  },
  replace(href: unknown): void {
    routerCalls.push({ method: 'replace', target: href });
  },
  back(): void {
    routerCalls.push({ method: 'back', target: '' });
  },
  canGoBack(): boolean {
    return false;
  },
};

export function useRouter(): typeof router {
  return router;
}

let currentPathname = '/today';

export function setPathname(pathname: string): void {
  currentPathname = pathname;
}

export function usePathname(): string {
  return currentPathname;
}

/** Redirects render nothing and are recorded for guard assertions. */
export const redirects: unknown[] = [];

export function clearRedirects(): void {
  redirects.length = 0;
}

export function Redirect({ href }: { href: unknown }): null {
  redirects.push(href);
  return null;
}

/** Tabs render as host elements so the layout suite can count screens. */
type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function TabsComponent(props: AnyProps): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('Tabs', rest, children);
}

function TabsScreen(props: AnyProps): React.ReactElement {
  return React.createElement('TabsScreen', props);
}

TabsComponent.Screen = TabsScreen;

export const Tabs = TabsComponent;
