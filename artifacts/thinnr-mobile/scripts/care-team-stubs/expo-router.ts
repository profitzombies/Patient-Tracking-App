export const routerCalls: unknown[] = [];
export const router = { push: (route: unknown) => routerCalls.push(route), back: () => routerCalls.push('back') };
export type Href = string | { pathname: string; params?: Record<string, string> };
export function useRouter() { return router; }
export function useLocalSearchParams() { return {}; }
export function useFocusEffect(effect: () => void | (() => void)): void {
  const React = require('react') as typeof import('react');
  React.useEffect(effect, [effect]);
}