/**
 * Node stand-in for expo-image-picker: counts camera and library launches
 * so the suite can prove a locked entry point never reaches either, and
 * an unlocked one still does. Every launch answers "canceled".
 */
export interface ImagePickerResult {
  canceled: boolean;
  assets: Array<{ uri: string; width?: number; height?: number }> | null;
}

export const pickerCalls = { camera: 0, library: 0 };

/** Next library result; null → canceled. Consumed by one launch. */
export const pickerScript: { next: ImagePickerResult | null } = { next: null };

export function resetPickerCalls(): void {
  pickerCalls.camera = 0;
  pickerCalls.library = 0;
  pickerScript.next = null;
}

export async function requestCameraPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}

export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}

export async function launchCameraAsync(_options?: unknown): Promise<ImagePickerResult> {
  pickerCalls.camera += 1;
  return { canceled: true, assets: null };
}

export async function launchImageLibraryAsync(_options?: unknown): Promise<ImagePickerResult> {
  pickerCalls.library += 1;
  const result = pickerScript.next ?? { canceled: true, assets: null };
  pickerScript.next = null;
  return result;
}
