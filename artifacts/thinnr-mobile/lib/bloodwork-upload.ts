import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { assertSuccessfulUploadStatus, uploadPercent } from '@/lib/bloodwork-scope';

export async function uploadFileWithProgress(
  url: string,
  uri: string,
  mimeType: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };
      xhr.onerror = () => {
        cleanup();
        reject(new Error('Network error during upload'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('Upload cancelled', 'AbortError'));
      };
      
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', mimeType);
      const abort = () => xhr.abort();
      signal?.addEventListener('abort', abort, { once: true });
      
      fetch(uri, { signal })
        .then(res => res.blob())
        .then(blob => {
          if (signal?.aborted) {
            xhr.abort();
          } else {
            xhr.send(blob);
          }
        })
        .catch(reject);
    });
  } else {
    // Native upload with real byte streaming
    const uploadTask = FileSystem.createUploadTask(
      url,
      uri,
      {
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': mimeType },
      },
      (data: FileSystem.UploadProgressData) => {
        onProgress(uploadPercent(data.totalBytesSent, data.totalBytesExpectedToSend));
      }
    );
    const abort = () => {
      void uploadTask.cancelAsync();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const response = await uploadTask.uploadAsync();
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    assertSuccessfulUploadStatus(response?.status);
  }
}
