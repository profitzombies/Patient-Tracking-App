export const routeEvents: Array<{ kind: string; href?: string }> = [];

export const router = {
  push(href: string) {
    routeEvents.push({ kind: 'push', href });
  },
  replace(href: string) {
    routeEvents.push({ kind: 'replace', href });
  },
  back() {
    routeEvents.push({ kind: 'back' });
  },
};