import Stripe from "stripe";

const TTL_MS = 5 * 60_000;

export class BillingConfigError extends Error {
  readonly status = 503;
}

export interface StripeCredentials {
  secret: string;
  publishable: string;
  account_id: string;
}

let credentialsCache: { value: StripeCredentials; expires: number } | null = null;
let stripeCache: { secret: string; value: Stripe } | null = null;
let testStripe: Stripe | null = null;

function connectionToken(): string {
  if (process.env.REPL_IDENTITY) return `repl ${process.env.REPL_IDENTITY}`;
  if (process.env.WEB_REPL_RENEWAL) return `depl ${process.env.WEB_REPL_RENEWAL}`;
  throw new BillingConfigError("Stripe connection is unavailable.");
}

export async function getStripeCredentials(): Promise<StripeCredentials> {
  if (credentialsCache && credentialsCache.expires > Date.now()) return credentialsCache.value;
  const host = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!host) throw new BillingConfigError("Stripe connection is unavailable.");
  try {
    const response = await fetch(
      `https://${host}/api/v2/connection?include_secrets=true&connector_names=stripe`,
      { headers: { X_REPLIT_TOKEN: connectionToken() }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`connection response ${response.status}`);
    const payload = await response.json() as { items?: Array<{ settings?: Partial<StripeCredentials> }> };
    const settings = payload.items?.[0]?.settings;
    if (!settings?.secret || !settings.publishable || !settings.account_id) throw new Error("missing settings");
    const value = settings as StripeCredentials;
    credentialsCache = { value, expires: Date.now() + TTL_MS };
    return value;
  } catch (error) {
    if (error instanceof BillingConfigError) throw error;
    throw new BillingConfigError("Stripe connection is unavailable.");
  }
}

export async function getStripe(): Promise<Stripe> {
  if (testStripe) return testStripe;
  const credentials = await getStripeCredentials();
  if (!stripeCache || stripeCache.secret !== credentials.secret) {
    stripeCache = {
      secret: credentials.secret,
      value: new Stripe(credentials.secret, { appInfo: { name: "THINNR Operations" } }),
    };
  }
  return stripeCache.value;
}

export async function getPublishableKey(): Promise<string> {
  return (await getStripeCredentials()).publishable;
}
export async function isSandbox(): Promise<boolean> {
  return (await getPublishableKey()).startsWith("pk_test_");
}
export async function getPlatformAccountId(): Promise<string> {
  return (await getStripeCredentials()).account_id;
}
export function getConnectClientId(): string | null {
  return process.env.STRIPE_CONNECT_CLIENT_ID?.trim() || null;
}
export function connectedOpts(accountId: string, idempotencyKey?: string) {
  return { stripeAccount: accountId, ...(idempotencyKey ? { idempotencyKey } : {}) };
}
export function __setStripeForTests(stripe: Stripe | null): void {
  testStripe = stripe;
}
export function __setCredentialsForTests(value: StripeCredentials | null): void {
  credentialsCache = value ? { value, expires: Number.POSITIVE_INFINITY } : null;
  stripeCache = null;
}