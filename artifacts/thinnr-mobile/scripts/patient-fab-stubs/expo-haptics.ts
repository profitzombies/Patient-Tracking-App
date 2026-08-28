/**
 * Node stand-in for expo-haptics that RECORDS cues — the suite asserts a
 * selection cue fires on every launcher toggle and row select.
 */
export const hapticCalls: string[] = [];

export function clearHapticCalls(): void {
  hapticCalls.length = 0;
}

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

export async function selectionAsync(): Promise<void> {
  hapticCalls.push('selection');
}

export async function notificationAsync(type?: unknown): Promise<void> {
  hapticCalls.push(`notification:${String(type)}`);
}

export async function impactAsync(style?: unknown): Promise<void> {
  hapticCalls.push(`impact:${String(style)}`);
}
