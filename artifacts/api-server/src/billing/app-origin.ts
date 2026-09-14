export function publicOrigin(): string {
  const configured = process.env.BILLING_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (!domain) throw new Error("BILLING_PUBLIC_ORIGIN or REPLIT_DOMAINS is required");
  return `https://${domain}`;
}