/**
 * No-op Node stand-in for expo-haptics (mapped by tsconfig.meal-photo.json).
 * PatientContext fires haptics on every mutation; under Node they are
 * meaningless, so every call resolves silently.
 */
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' } as const;
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' } as const;

export async function impactAsync(_style?: unknown): Promise<void> {}
export async function selectionAsync(): Promise<void> {}
export async function notificationAsync(_type?: unknown): Promise<void> {}
