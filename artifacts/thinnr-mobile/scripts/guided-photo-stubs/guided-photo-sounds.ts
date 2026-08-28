/**
 * Node stand-in for data/guided-photo-sounds (static .wav require()s).
 * Distinct sentinels let the suite tell the tick player from the capture
 * tone in the expo-audio stub's records.
 */
export const TICK_SOUND = { sound: 'tick' };
export const CAPTURE_TONE_SOUND = { sound: 'capture-tone' };
