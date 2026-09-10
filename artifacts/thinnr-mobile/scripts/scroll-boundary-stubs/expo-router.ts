import React from 'react';

export type Href = string;

export const router = {
  push(_href: unknown): void {},
  replace(_href: unknown): void {},
  navigate(_href: unknown): void {},
  back(): void {},
  canGoBack(): boolean {
    return true;
  },
};

export function useRouter(): typeof router {
  return router;
}

export function usePathname(): string {
  return '/today';
}

export function useSegments(): string[] {
  return [];
}

export function useFocusEffect(_effect: () => void | (() => void)): void {}

export function Redirect(props: { href: unknown }): React.ReactElement {
  return React.createElement('Redirect', { href: String(props.href) });
}

function TabsImpl(props: Record<string, unknown> & { children?: React.ReactNode }): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('Tabs', rest, children);
}

function TabsScreen(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('TabsScreen', props);
}

export const Tabs = Object.assign(TabsImpl, { Screen: TabsScreen });