/**
 * Stand-in for '@/lib/demo-entry' used by scripts/verify-demo-switch.tsx
 * (mapped via tsconfig.demo-switch.json): demo entry pinned OFF, exactly as
 * the published app compiles it. The real resolver is re-exported so the
 * suite exercises the same rule the app uses.
 */
export { resolveDemoEntry } from '../../src/lib/demo-entry';

export const demoEntryEnabled = false;
