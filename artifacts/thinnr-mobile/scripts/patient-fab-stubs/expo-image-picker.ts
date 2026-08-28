/**
 * Node stand-in for expo-image-picker: the web capture path goes straight
 * to the library picker, so the suite scripts its next result and counts
 * launches.
 */
export interface ImagePickerAsset {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string;
  base64?: string | null;
}

export interface ImagePickerResult {
  canceled: boolean;
  assets: ImagePickerAsset[] | null;
}

export const pickerCalls = { count: 0 };

/** Next launchImageLibraryAsync result; null → canceled. */
export const pickerScript: { next: ImagePickerResult | null } = { next: null };

export async function launchImageLibraryAsync(_options?: unknown): Promise<ImagePickerResult> {
  pickerCalls.count += 1;
  const result = pickerScript.next ?? { canceled: true, assets: null };
  pickerScript.next = null;
  return result;
}

export const permissionScript = { granted: true };

export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: permissionScript.granted };
}
