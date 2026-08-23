/**
 * Node stand-in for expo-haptics (see tsconfig.onboarding-hints.json `paths`).
 * The onboarding widgets fire selection/impact/notification haptics on every
 * tap; under Node they are inert.
 */
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
export async function impactAsync(_style?: unknown): Promise<void> {}
export async function notificationAsync(_type?: unknown): Promise<void> {}
