/**
 * Node stand-in for the slice of react-native that lib/coach-api.ts touches.
 *
 * Mapped over the real package by tsconfig.coach-stop.json (`paths`) so the
 * coach stop-control suite can run the real streaming client under tsx, where
 * the actual react-native package cannot be loaded. Platform.OS reports 'web'
 * so streamCoachChat binds globalThis.fetch — which the suite replaces with a
 * scripted SSE fake.
 */
export const Platform = { OS: 'web' as const };
