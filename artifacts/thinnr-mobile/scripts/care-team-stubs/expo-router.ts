export const routerCalls: string[] = [];
export const router = { push: (route: string) => routerCalls.push(route), back: () => routerCalls.push('back') };
export function useRouter() { return router; }
export function useLocalSearchParams() { return {}; }
export function useFocusEffect(effect: () => void | (() => void)): void {
  const React = require('react') as typeof import('react');
  React.useEffect(effect, [effect]);
}