/**
 * Node stand-in for expo-router used by the payments suites (see
 * tsconfig.payments.json `paths`). Extends the provider-training stub with
 * the pieces the Payments area uses: `router.navigate` (section strip,
 * links) and a pass-through <Stack>. `routerLog` records every hop so the
 * suites can assert on navigation targets.
 */
import React from 'react';
import { routerLog, router as baseRouter } from '../provider-training-stubs/expo-router';

export * from '../provider-training-stubs/expo-router';

type Target = string | { pathname: string; params?: Record<string, string> };

function stringify(href: Target): string {
  if (typeof href === 'string') return href;
  const params = href.params ? new URLSearchParams(href.params).toString() : '';
  return params ? `${href.pathname}?${params}` : href.pathname;
}

export const router = {
  ...baseRouter,
  push(href: Target): void {
    routerLog.push({ method: 'push', target: stringify(href) });
  },
  replace(href: Target): void {
    routerLog.push({ method: 'replace', target: stringify(href) });
  },
  navigate(href: Target): void {
    routerLog.push({ method: 'push', target: stringify(href) });
  },
};

export function useRouter() {
  return router;
}

export function Stack(props: { children?: React.ReactNode }) {
  return React.createElement('Stack', null, props.children);
}
Stack.Screen = function Screen() {
  return null;
};

export function Link(props: { href: Target; children?: React.ReactNode; [key: string]: unknown }) {
  const { href, children, ...rest } = props;
  return React.createElement('Link', { ...rest, href: stringify(href) }, children);
}
