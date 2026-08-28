/** Node stand-in for expo-haptics: counts selection ticks (press feedback). */
export const selectionCalls = { count: 0 };

export async function selectionAsync(): Promise<void> {
  selectionCalls.count += 1;
}
