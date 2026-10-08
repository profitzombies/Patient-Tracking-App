import Stripe from "stripe";
import { publicOrigin } from "./app-origin";
import { BillingConfigError, getStripe } from "./stripe-client";
import type { WebhookEndpointKind } from "./webhooks";

export type WebhookMode = "test" | "live";
/** Configure these event subscriptions in the Stripe Dashboard; never provision at boot. */
export const BILLING_WEBHOOK_EVENTS = {
  platform: [
    "account.application.deauthorized",
    // Office access: THINNR charges offices on the platform account. Bank
    // debits settle (or bounce) days later and saved methods are confirmed
    // asynchronously, so these arrive only as platform events.
    "payment_intent.succeeded", "payment_intent.payment_failed", "charge.dispute.created",
    "setup_intent.succeeded", "setup_intent.setup_failed",
  ],
  connect: [
    "account.updated", "capability.updated", "invoice.created", "invoice.paid", "invoice.payment_failed",
    "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
    "invoice.finalized", "charge.refunded", "refund.updated",
    "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
    "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated", "payout.paid", "payout.failed",
    "payout.canceled", "payment_intent.payment_failed",
  ],
} as const;

/** Events a Connect endpoint must carry for setup status to update on its own. */
export const REQUIRED_CONNECT_EVENTS = ["account.updated", "capability.updated"] as const;
/**
 * Stripe delivers a connected account's "disconnected from your platform"
 * notice to Connect endpoints; the app handles it on either endpoint, so it
 * is recommended there (a warning when absent) rather than required.
 */
const RECOMMENDED_CONNECT_EVENTS = [...BILLING_WEBHOOK_EVENTS.connect, "account.application.deauthorized"] as const;

export function requiredWebhookEvents(kind: WebhookEndpointKind): readonly string[] {
  return kind === "connect" ? REQUIRED_CONNECT_EVENTS : BILLING_WEBHOOK_EVENTS.platform;
}
export function recommendedWebhookEvents(kind: WebhookEndpointKind): readonly string[] {
  return kind === "connect" ? RECOMMENDED_CONNECT_EVENTS : [];
}

/** The API version this server's Stripe SDK speaks (and parses event payloads as). */
export const EXPECTED_STRIPE_API_VERSION: string = Stripe.API_VERSION;

/**
 * Stripe names versions `YYYY-MM-DD.family`. Releases inside one family are
 * backwards compatible; a different family can reshape event payloads.
 */
export function apiVersionFamily(version: string | null | undefined): string | null {
  const match = /^\d{4}-\d{2}-\d{2}\.([a-z]+)$/.exec(version?.trim() ?? "");
  return match ? match[1] : null;
}

export function webhookSecretName(kind: WebhookEndpointKind, mode: WebhookMode): string {
  return `STRIPE_${mode.toUpperCase()}_${kind.toUpperCase()}_WEBHOOK_SECRET`;
}

export function webhookUrl(origin: string, mode: WebhookMode, kind: WebhookEndpointKind): string {
  return `${origin}/api/billing/webhooks/${mode}/${kind}`;
}

export type WebhookEndpointVerdict =
  | "missing" | "wrong_scope" | "disabled" | "missing_events" | "secret_missing"
  | "version_unknown" | "version_mismatch" | "missing_recommended" | "ok";

export interface WebhookEndpointEvaluation {
  verdict: WebhookEndpointVerdict;
  endpoint: Stripe.WebhookEndpoint | null;
  missingRequired: string[];
  missingRecommended: string[];
  /** The version Stripe renders this endpoint's events in; null when it cannot be told. */
  apiVersion: string | null;
  apiVersionSource: "endpoint" | "account_default" | "unknown";
}

/**
 * One endpoint's verdict, shared by the launch readiness checklist and the
 * Payments health banner. Problems are reported in the order an operator
 * fixes them: the endpoint must exist, listen to the right source, be on,
 * carry the events, have its secret saved here and speak our API version.
 */
export function evaluateWebhookEndpoint(input: {
  kind: WebhookEndpointKind;
  url: string;
  endpoints: readonly Stripe.WebhookEndpoint[];
  secretSet: boolean;
  /** Version of the account's own recent events; used when an endpoint pins none. */
  accountDefaultVersion: string | null;
  expectedVersion?: string;
}): WebhookEndpointEvaluation {
  const required = requiredWebhookEvents(input.kind);
  const recommended = recommendedWebhookEvents(input.kind);
  const match = input.endpoints.find((endpoint) => endpoint.url.replace(/\/$/, "") === input.url) ?? null;
  if (!match) {
    return { verdict: "missing", endpoint: null, missingRequired: [...required], missingRecommended: recommended.filter((event) => !required.includes(event)), apiVersion: null, apiVersionSource: "unknown" };
  }
  const events = new Set(match.enabled_events);
  const all = events.has("*");
  const missingRequired = all ? [] : required.filter((event) => !events.has(event));
  const missingRecommended = all ? [] : recommended.filter((event) => !events.has(event) && !required.includes(event));
  const pinned = match.api_version?.trim() || null;
  const apiVersion = pinned ?? input.accountDefaultVersion ?? null;
  const apiVersionSource = pinned ? "endpoint" : input.accountDefaultVersion ? "account_default" : "unknown";
  const base = { endpoint: match, missingRequired, missingRecommended, apiVersion, apiVersionSource } as const;
  // Stripe marks endpoints for connected-account events with the Connect
  // application id; platform endpoints carry none. A mix-up would leave
  // office setup status (Connect account.updated) never arriving.
  const receivesConnect = Boolean(match.application);
  if ((input.kind === "connect") !== receivesConnect) return { ...base, verdict: "wrong_scope" };
  if (match.status !== "enabled") return { ...base, verdict: "disabled" };
  if (missingRequired.length) return { ...base, verdict: "missing_events" };
  if (!input.secretSet) return { ...base, verdict: "secret_missing" };
  const expected = apiVersionFamily(input.expectedVersion ?? EXPECTED_STRIPE_API_VERSION);
  const actual = apiVersionFamily(apiVersion);
  // No pinned version and no recent event to read the account default from:
  // the version cannot be judged, so it is a check to do, never "ok".
  if (!actual) return { ...base, verdict: "version_unknown" };
  if (expected && expected !== actual) return { ...base, verdict: "version_mismatch" };
  if (missingRecommended.length) return { ...base, verdict: "missing_recommended" };
  return { ...base, verdict: "ok" };
}

/** The API version of the account's newest event, or null when none can be read. */
export async function accountDefaultApiVersion(stripe: Partial<Pick<Stripe, "events">>): Promise<string | null> {
  try {
    if (!stripe.events?.list) return null;
    const page = await stripe.events.list({ limit: 1 });
    return page.data[0]?.api_version ?? null;
  } catch {
    return null;
  }
}

export interface BillingWebhookEndpointHealth {
  kind: WebhookEndpointKind;
  url: string;
  /** "unknown" when Stripe could not be asked (keys failing, origin missing). */
  status: WebhookEndpointVerdict | "unknown";
  enabled_events: number;
  missing_events: string[];
  missing_recommended_events: string[];
  api_version: string | null;
  secret_configured: boolean;
}

export interface BillingWebhookHealth {
  mode: WebhookMode;
  /** True only when both endpoints exist, are on, carry every billing event, have their secret saved and are known to speak our API version. */
  registered: boolean;
  expected_api_version: string;
  endpoints: BillingWebhookEndpointHealth[];
  last_error: string | null;
  last_checked_at: string | null;
}

export async function getEndpointSecret(kind: WebhookEndpointKind, mode: WebhookMode): Promise<string> {
  const name = webhookSecretName(kind, mode);
  const secret = process.env[name]?.trim();
  if (!secret || !/^whsec_\S+$/.test(secret)) {
    throw new BillingConfigError(`Configure ${name} for billing webhook verification.`);
  }
  return secret;
}

/** Compatibility with startup/reconciliation callers. No Stripe or database mutations. */
export async function ensureBillingWebhookEndpoints(): Promise<void> {}
export function stopBillingWebhookEndpointRetry(): void {}

/**
 * Vendor errors never reach HQ verbatim (a message could echo a key
 * fragment); our own configuration errors name the setting, not its value.
 */
function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof BillingConfigError && error.message) return error.message;
  const raw = error && typeof error === "object"
    ? (error as { code?: unknown; type?: unknown }).code ?? (error as { type?: unknown }).type
    : null;
  const code = typeof raw === "string" && /^[A-Za-z_]{1,48}$/.test(raw) ? raw : null;
  return code ? `${fallback} (${code})` : fallback;
}

const HEALTH_TTL_MS = 60_000;
const healthCache = new Map<WebhookMode, { expires: number; value: Promise<BillingWebhookHealth> }>();

/** Test hook: forget cached Dashboard reads. */
export function resetBillingWebhookHealthCache(): void {
  healthCache.clear();
}

/**
 * What Stripe's Dashboard actually has for this site in one mode: lists the
 * mode's webhook endpoints (read-only) and judges each against the events,
 * secret and API version the server needs. Cached for a minute per mode so
 * the polling Payments page does not hammer Stripe.
 */
export async function getBillingWebhookHealth(mode: WebhookMode): Promise<BillingWebhookHealth> {
  const now = Date.now();
  const cached = healthCache.get(mode);
  if (cached && cached.expires > now) return cached.value;
  const value = computeWebhookHealth(mode);
  healthCache.set(mode, { expires: now + HEALTH_TTL_MS, value });
  return value;
}

async function computeWebhookHealth(mode: WebhookMode): Promise<BillingWebhookHealth> {
  const checkedAt = new Date().toISOString();
  let error: string | null = null;
  let origin: string | null = null;
  try { origin = publicOrigin(); } catch (cause) { error = safeMessage(cause, "The billing public origin is not configured."); }
  let endpoints: Stripe.WebhookEndpoint[] | null = null;
  let accountDefault: string | null = null;
  if (origin) {
    try {
      const stripe = await getStripe(mode);
      endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data;
      if (endpoints.some((endpoint) => !endpoint.api_version)) accountDefault = await accountDefaultApiVersion(stripe);
    } catch (cause) {
      error = safeMessage(cause, "Stripe webhook endpoints could not be listed.");
    }
  }
  const rows = (["platform", "connect"] as const).map((kind): BillingWebhookEndpointHealth => {
    const secretConfigured = /^whsec_\S+$/.test(process.env[webhookSecretName(kind, mode)]?.trim() ?? "");
    const url = origin ? webhookUrl(origin, mode, kind) : "";
    if (!origin || !endpoints) {
      return { kind, url, status: "unknown", enabled_events: 0, missing_events: [], missing_recommended_events: [], api_version: null, secret_configured: secretConfigured };
    }
    const evaluation = evaluateWebhookEndpoint({ kind, url, endpoints, secretSet: secretConfigured, accountDefaultVersion: accountDefault });
    return {
      kind, url, status: evaluation.verdict,
      enabled_events: evaluation.endpoint?.enabled_events.length ?? 0,
      missing_events: evaluation.missingRequired,
      missing_recommended_events: evaluation.missingRecommended,
      api_version: evaluation.apiVersion,
      secret_configured: secretConfigured,
    };
  });
  return {
    mode,
    registered: rows.every((row) => row.status === "ok"),
    expected_api_version: EXPECTED_STRIPE_API_VERSION,
    endpoints: rows,
    last_error: error,
    last_checked_at: checkedAt,
  };
}
