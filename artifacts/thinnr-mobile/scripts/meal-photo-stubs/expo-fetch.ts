/**
 * Node stand-in for expo/fetch for the meal-photo suite. Unlike the
 * coach-stop version (which throws), this delegates to globalThis.fetch AT
 * CALL TIME: the camera integration scenario flips Platform.OS to 'ios',
 * where lib/coach-api picks expo/fetch over the browser fetch — and the
 * suite's scripted SSE transport must keep receiving those calls.
 */
export function fetch(
  ...args: Parameters<typeof globalThis.fetch>
): ReturnType<typeof globalThis.fetch> {
  return globalThis.fetch(...args);
}
