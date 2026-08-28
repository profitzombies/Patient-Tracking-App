/**
 * Node stand-in for expo-router for the patient-fab suite: records
 * navigation calls (rows push /log-food, /barcode-scan, /check-in,
 * /coach-chat, /food-camera; "Progress photos" navigates to the /progress
 * tab), lets scenarios pick the active pathname (active-tick + skip-when-
 * already-there semantics), and renders Tabs / Tabs.Screen as bare host
 * elements so the REAL patient tab layout can mount under Node with its
 * screen registrations visible to the tree.
 */
import React from 'react';

export type Href = string;

export interface RouterCall {
  method: 'push' | 'replace' | 'back' | 'navigate';
  target: string;
}

export const routerCalls: RouterCall[] = [];

export function clearRouterCalls(): void {
  routerCalls.length = 0;
}

/** Active pathname reported by usePathname; set per scenario. */
export const routerState = { pathname: '/today' };

const routerApi = {
  push(href: unknown): void {
    routerCalls.push({ method: 'push', target: String(href) });
  },
  replace(href: unknown): void {
    routerCalls.push({ method: 'replace', target: String(href) });
  },
  navigate(href: unknown): void {
    routerCalls.push({ method: 'navigate', target: String(href) });
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

/** Redirects render as a queryable host node instead of navigating. */
export function Redirect(props: { href: unknown }): React.ReactElement {
  return React.createElement('Redirect', { href: String(props.href) });
}

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function TabsImpl(props: AnyProps): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('Tabs', rest, children);
}

/** Screen registrations stay visible (name + options) but render nothing. */
function TabsScreen(props: AnyProps): React.ReactElement {
  return React.createElement('TabsScreen', props);
}

export const Tabs = Object.assign(TabsImpl, { Screen: TabsScreen });
