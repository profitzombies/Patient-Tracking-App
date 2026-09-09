export enum FileSystemUploadType {
  BINARY_CONTENT = 0,
}

export interface UploadProgressData {
  totalBytesSent: number;
  totalBytesExpectedToSend: number;
}

let status = 200;
let holdUntilCancel = false;
export let cancelCalls = 0;
export let lastOptions: { headers?: Record<string, string> } | null = null;

export function configureUpload(next: { status: number; holdUntilCancel?: boolean }): void {
  status = next.status;
  holdUntilCancel = next.holdUntilCancel ?? false;
  cancelCalls = 0;
  lastOptions = null;
}

export function createUploadTask(
  _url: string,
  _uri: string,
  options: { headers?: Record<string, string> },
  onProgress: (data: UploadProgressData) => void,
) {
  lastOptions = options;
  let resolveHeld: ((value: { status: number }) => void) | null = null;
  return {
    uploadAsync: async () => {
      onProgress({ totalBytesSent: 5, totalBytesExpectedToSend: 20 });
      if (!holdUntilCancel) return { status };
      return new Promise<{ status: number }>(resolve => {
        resolveHeld = resolve;
      });
    },
    cancelAsync: async () => {
      cancelCalls += 1;
      resolveHeld?.({ status });
    },
  };
}