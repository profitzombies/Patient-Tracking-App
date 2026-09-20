import Stripe from "stripe";
import { currentBillingIdentity, type StripeMode } from "./stripe-environment";

const TTL_MS = 5 * 60_000;

export class BillingConfigError extends Error {
  readonly status = 503;
}

/**
 * A deterministic Stripe rejection (invalid_request_error, 4xx other than
 * rate limits). Retrying will not help, so staff surfaces should say what
 * Stripe said instead of "temporarily unavailable". Never used for public
 * (payer-facing) routes.
 */
export function stripeRejection(error: unknown): { status: number; message: string } | null {
  if (!(error instanceof Stripe.errors.StripeError)) return null;
  if (error.type !== "StripeInvalidRequestError") return null;
  const code = error.statusCode ?? 400;
  if (code < 400 || code >= 500 || code === 429) return null;
  return { status: 502, message: `Stripe rejected the request: ${error.message}` };
}

/**
 * True only when Stripe says the object does not exist on the account the
 * request was made against (`resource_missing`). Transient failures (timeouts,
 * 429, 5xx, auth problems) are NOT "missing" and must be re-thrown by callers
 * that would otherwise rebuild the object.
 */
export function isStripeMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.code === "resource_missing";
}

export interface StripeCredentials {
  secret: string;
  publishable: string;
  account_id: string;
}

let testCredentials: StripeCredentials | null = null;
const stripeCache = new Map<StripeMode, { secret: string; accountId: string; value: Stripe; verifiedUntil: number; verifying?: Promise<void> }>();
let testStripe: Stripe | null = null;

function selectedMode(mode?: StripeMode): StripeMode {
  const selected = mode ?? currentBillingIdentity()?.mode ?? "test";
  if (selected !== "test" && selected !== "live") throw new BillingConfigError("Invalid Stripe mode.");
  return selected;
}

export async function getStripeCredentials(mode?: StripeMode): Promise<StripeCredentials> {
  if (testCredentials && process.env.NODE_ENV === "test") return testCredentials;
  const selected = selectedMode(mode);
  const prefix = `STRIPE_${selected.toUpperCase()}_`;
  const read = (suffix: string) => {
    const value = process.env[prefix + suffix]?.trim();
    if (!value) throw new BillingConfigError(`Payments are not configured: ${prefix + suffix} is missing.`);
    return value;
  };
  const value = { secret: read("SECRET_KEY"), publishable: read("PUBLISHABLE_KEY"), account_id: read("PLATFORM_ACCOUNT_ID") };
  if (!new RegExp(`^sk_${selected}_[A-Za-z0-9]+$`).test(value.secret) ||
      !new RegExp(`^pk_${selected}_[A-Za-z0-9]+$`).test(value.publishable)) {
    throw new BillingConfigError(`Stripe ${selected} key types do not match the selected mode.`);
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(value.account_id)) throw new BillingConfigError(`${prefix}PLATFORM_ACCOUNT_ID is invalid.`);
  const pinned = currentBillingIdentity();
  if (pinned && (pinned.mode !== selected || pinned.platformAccountId !== value.account_id)) {
    throw new BillingConfigError("Stripe configuration changed. Reload before continuing.");
  }
  return value;
}

export async function getStripe(mode?: StripeMode): Promise<Stripe> {
  if (testStripe && process.env.NODE_ENV === "test") return testStripe;
  const selected = selectedMode(mode);
  const credentials = await getStripeCredentials(selected);
  let cached = stripeCache.get(selected);
  if (!cached || cached.secret !== credentials.secret || cached.accountId !== credentials.account_id) {
    cached = {
      secret: credentials.secret, accountId: credentials.account_id, verifiedUntil: 0,
      value: new Stripe(credentials.secret, { appInfo: { name: "THINNR Operations" }, timeout: 10_000 }),
    };
    stripeCache.set(selected, cached);
  }
  const entry = cached;
  if (entry.verifiedUntil <= Date.now()) {
    entry.verifying ??= (async () => {
      try {
        // SDK runtime supports GET /v1/account without an ID, but v22's
        // generated declaration only describes GET /v1/accounts/:id.
        // Never retrieve the configured ID here: a Connect platform could
        // retrieve another account without proving its own identity.
        const retrieveSelf = entry.value.accounts.retrieve as unknown as () => Promise<Stripe.Account>;
        const account = await retrieveSelf.call(entry.value.accounts);
        if (account.id !== entry.accountId) throw new BillingConfigError("Stripe platform account does not match the configured account.");
        entry.verifiedUntil = Date.now() + TTL_MS;
      } catch (error) {
        if (error instanceof BillingConfigError) throw error;
        throw new BillingConfigError("Stripe platform identity could not be verified. Payments are unavailable.");
      }
    })().finally(() => { entry.verifying = undefined; });
    await entry.verifying;
  }
  return entry.value;
}

export async function getPublishableKey(mode?: StripeMode): Promise<string> {
  return (await getStripeCredentials(mode)).publishable;
}
export async function isSandbox(mode?: StripeMode): Promise<boolean> {
  return (await getPublishableKey(mode)).startsWith("pk_test_");
}
export async function getPlatformAccountId(mode?: StripeMode): Promise<string> {
  return (await getStripeCredentials(mode)).account_id;
}
export function getConnectClientId(): string | null {
  const value = process.env[`STRIPE_${selectedMode().toUpperCase()}_CONNECT_CLIENT_ID`]?.trim();
  if (value && !/^ca_[A-Za-z0-9]+$/.test(value)) throw new BillingConfigError("Stripe Connect client ID is invalid.");
  return value || null;
}
export function connectedOpts(accountId: string, idempotencyKey?: string) {
  return { stripeAccount: accountId, ...(idempotencyKey ? { idempotencyKey } : {}) };
}
export function __setStripeForTests(stripe: Stripe | null): void {
  testStripe = stripe;
}
export function __setCredentialsForTests(value: StripeCredentials | null): void {
  testCredentials = value;
  stripeCache.clear();
}