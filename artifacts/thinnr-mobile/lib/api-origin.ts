export function configuredApiOrigin(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) throw new Error('EXPO_PUBLIC_DOMAIN is not set; cannot reach the API server');
  return `https://${domain}`;
}