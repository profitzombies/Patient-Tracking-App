import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { assertBloodworkByteSize, makeBloodworkUuid } from '@/lib/bloodwork-scope';

export interface BloodworkDraftFile {
  clientFileId: string;
  uri: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  fileName?: string;
  /** True only for cache files/blob URLs created by this bloodwork draft. */
  appOwned: boolean;
}

async function browserBlobFor(asset: { uri: string; file?: Blob }): Promise<Blob> {
  if (asset.file instanceof Blob) return asset.file;
  const response = await fetch(asset.uri);
  if (!response.ok) throw new Error('Selected file cannot be read.');
  return response.blob();
}

export async function assertBrowserPdf(blob: Blob): Promise<number> {
  const size = blob.size;
  assertBloodworkByteSize(size, 'PDF');
  const header = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...header) !== '%PDF-') {
    throw new Error('Selected file is mislabeled or is not a valid PDF.');
  }
  return size;
}

export async function pickBloodworkPdf(): Promise<BloodworkDraftFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const file = result.assets[0];
  if (!file) return null;

  // copyToCacheDirectory guarantees that native's returned URI is our app cache
  // copy, never the document provider's original. Ownership transfers to the
  // screen only after every validation succeeds.
  let ownedUri: string | null = Platform.OS === 'web' ? null : file.uri;
  let handedOff = false;
  try {
    if (file.mimeType && file.mimeType !== 'application/pdf') {
      throw new Error('Selected file is not a valid PDF.');
    }

    let size: number;
    let uri = file.uri;
    if (Platform.OS === 'web') {
      const blob = await browserBlobFor(file);
      size = await assertBrowserPdf(blob);
      uri = URL.createObjectURL(blob);
      ownedUri = uri;
    } else {
      const info = await FileSystem.getInfoAsync(file.uri);
      size = info.exists && typeof info.size === 'number' ? info.size : 0;
      assertBloodworkByteSize(size, 'PDF');
      const header = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: 0,
        length: 5,
      });
      if (!header.startsWith('JVBER')) {
        throw new Error('Selected file is mislabeled or is not a valid PDF.');
      }
    }

    const draft: BloodworkDraftFile = {
      clientFileId: makeBloodworkUuid(),
      uri,
      mimeType: 'application/pdf',
      size,
      fileName: file.name,
      appOwned: true,
    };
    handedOff = true;
    return draft;
  } finally {
    if (!handedOff && ownedUri) {
      await disposeBloodworkOwnedUri(ownedUri);
    }
  }
}

export async function prepareBloodworkImage(
  asset: ImagePicker.ImagePickerAsset
): Promise<BloodworkDraftFile> {
  const MAX_EDGE = 3000;
  let action: { resize: { width: number } | { height: number } } | null = null;

  if (asset.width > MAX_EDGE || asset.height > MAX_EDGE) {
    if (asset.width > asset.height) {
      action = { resize: { width: MAX_EDGE } };
    } else {
      action = { resize: { height: MAX_EDGE } };
    }
  }

  const actions = action ? [action] : [];
  
  const result = await manipulateAsync(asset.uri, actions, {
    compress: 0.9,
    format: SaveFormat.JPEG,
  });

  let uri = result.uri;
  try {
    let size: number;
    if (Platform.OS === 'web') {
      const blob = await browserBlobFor(result);
      size = blob.size;
    } else {
      const fileInfo = await FileSystem.getInfoAsync(result.uri);
      size = fileInfo.exists && typeof fileInfo.size === 'number' ? fileInfo.size : 0;
    }

    assertBloodworkByteSize(size, 'Image');

    return {
      clientFileId: makeBloodworkUuid(),
      uri,
      mimeType: 'image/jpeg',
      size,
      width: result.width,
      height: result.height,
      appOwned: true,
    };
  } catch (error) {
    await disposeBloodworkOwnedUri(uri);
    throw error;
  }
}

export async function prepareBloodworkImageBatch(
  assets: readonly ImagePicker.ImagePickerAsset[],
  isCurrent: () => boolean,
  prepare: (asset: ImagePicker.ImagePickerAsset) => Promise<BloodworkDraftFile> = prepareBloodworkImage,
): Promise<BloodworkDraftFile[]> {
  const prepared: BloodworkDraftFile[] = [];
  try {
    for (const asset of assets) {
      const file = await prepare(asset);
      prepared.push(file);
      if (!isCurrent()) {
        await disposeBloodworkDraftFiles(prepared);
        return [];
      }
    }
    return prepared;
  } catch (error) {
    await disposeBloodworkDraftFiles(prepared);
    throw error;
  }
}

export async function disposeBloodworkDraftFiles(files: readonly BloodworkDraftFile[]): Promise<void> {
  await Promise.all(files.filter(file => file.appOwned).map(async file => {
    try {
      if (Platform.OS === 'web') {
        if (file.uri.startsWith('blob:')) URL.revokeObjectURL(file.uri);
      } else {
        await FileSystem.deleteAsync(file.uri, { idempotent: true });
      }
    } catch {
      // A picker URI may already have been reclaimed by the operating system.
    }
  }));
}

export async function disposeBloodworkOwnedUri(uri: string): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (uri.startsWith('blob:')) URL.revokeObjectURL(uri);
    } else {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch {
    // Camera/cache cleanup is best-effort; server reconciliation remains separate.
  }
}
