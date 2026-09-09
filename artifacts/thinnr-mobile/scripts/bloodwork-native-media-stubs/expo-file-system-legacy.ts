export const EncodingType = { Base64: 'base64' };

let size = 100;
let header = 'JVBER';
let infoError: Error | null = null;
let readError: Error | null = null;
export const deletedUris: string[] = [];

export function configureNativeFile(input: {
  size?: number;
  header?: string;
  infoError?: Error | null;
  readError?: Error | null;
}): void {
  size = input.size ?? 100;
  header = input.header ?? 'JVBER';
  infoError = input.infoError ?? null;
  readError = input.readError ?? null;
  deletedUris.length = 0;
}

export async function getInfoAsync() {
  if (infoError) throw infoError;
  return { exists: true as const, size };
}

export async function readAsStringAsync() {
  if (readError) throw readError;
  return header;
}

export async function deleteAsync(uri: string): Promise<void> {
  deletedUris.push(uri);
}