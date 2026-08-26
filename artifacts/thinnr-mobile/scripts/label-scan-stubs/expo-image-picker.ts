/**
 * Node stand-in for expo-image-picker: the suite scripts picker results and
 * permission answers, and can inspect the options each launch was given.
 */
export interface ImagePickerAsset {
  uri: string;
  width?: number;
  height?: number;
  base64?: string | null;
  mimeType?: string;
}

export interface ImagePickerResult {
  canceled: boolean;
  assets: ImagePickerAsset[] | null;
}

export const pickerState = {
  /** Queued results for launchImageLibraryAsync, consumed in order. */
  library: [] as ImagePickerResult[],
  /** Queued results for launchCameraAsync, consumed in order. */
  camera: [] as ImagePickerResult[],
  libraryPermission: true,
  cameraPermission: true,
  libraryLaunchOptions: [] as unknown[],
};

export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: pickerState.libraryPermission };
}

export async function requestCameraPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: pickerState.cameraPermission };
}

export async function launchImageLibraryAsync(options?: unknown): Promise<ImagePickerResult> {
  pickerState.libraryLaunchOptions.push(options);
  return pickerState.library.shift() ?? { canceled: true, assets: null };
}

export async function launchCameraAsync(_options?: unknown): Promise<ImagePickerResult> {
  return pickerState.camera.shift() ?? { canceled: true, assets: null };
}
