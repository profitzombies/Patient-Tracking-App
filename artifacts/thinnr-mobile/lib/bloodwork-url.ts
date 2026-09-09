import { configuredApiOrigin } from '@/lib/api-origin';

export function resolveBloodworkSourceUrl(generatedPath: string): string {
  const trustedOrigin = configuredApiOrigin();
  const resolved = new URL(generatedPath, trustedOrigin);
  if (resolved.origin !== trustedOrigin) {
    throw new Error('Refusing to load a bloodwork source from an untrusted origin.');
  }
  return resolved.toString();
}