/**
 * Node stand-in for expo-router (see tsconfig.onboarding-hints.json `paths`).
 *
 * OnboardingContext's goNext/goBack call router.push/replace/back; the stub
 * records every call so the suite can assert the single invariant that
 * matters: a blocked Next tap records NO push, a valid one records exactly
 * the next step's route. The suite imports `routerLog` through the same
 * 'expo-router' specifier, so it shares this module instance with the
 * components under test.
 */
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
