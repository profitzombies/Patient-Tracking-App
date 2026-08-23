/**
 * Node stand-in for expo/fetch (see tsconfig.coach-stop.json `paths`).
 *
 * lib/coach-api.ts only reaches for expo/fetch when Platform.OS is not 'web';
 * the react-native stub pins Platform.OS to 'web', so this must never run —
 * it exists purely so the import resolves under tsx.
 */
export function fetch(): never {
  throw new Error('expo/fetch stub must not be called when Platform.OS is "web"');
}
