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
export async function impactAsync(_style?: unknown): Promise<void> {}
