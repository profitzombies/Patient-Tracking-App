/** Node stand-in for expo-haptics: every cue is a resolved no-op promise. */
export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;

export const ImpactFeedbackStyle = {
  Light: 'light',
  Medium: 'medium',
  Heavy: 'heavy',
} as const;

export async function selectionAsync(): Promise<void> {}
export async function notificationAsync(_type?: unknown): Promise<void> {}

let heldImpact: Promise<void> | null = null;
let releaseHeldImpact: (() => void) | null = null;

/** Test-only control proving account identity is captured before haptic awaits. */
export function holdNextImpact(): void {
  heldImpact = new Promise(resolve => {
    releaseHeldImpact = resolve;
  });
}

export function releaseImpact(): void {
  releaseHeldImpact?.();
  releaseHeldImpact = null;
}

export async function impactAsync(_style?: unknown): Promise<void> {
  const pending = heldImpact;
  heldImpact = null;
  if (pending) await pending;
}
