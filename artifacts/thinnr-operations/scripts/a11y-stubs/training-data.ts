/**
 * Swappable stand-in for '@/contexts/training-data' used by
 * scripts/verify-training-a11y.tsx (mapped via tsconfig.a11y.json).
 * The suite injects the exact snapshot the real pages render.
 */
import type { ReactNode } from 'react';

let snapshot: any = {
  status: 'ready',
  errorMessage: null,
  refresh: () => {},
  courses: [],
  viewers: [],
  completionIndex: new Map(),
  myViewer: null,
};

export function __setTrainingData(next: Record<string, unknown>) {
  snapshot = { ...snapshot, ...next };
}

export function useTrainingData() {
  return snapshot;
}

export function TrainingDataProvider({ children }: { children: ReactNode }) {
  return children;
}
