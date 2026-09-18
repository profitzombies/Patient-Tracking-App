import Stripe from "stripe";
import { logger } from "../lib/logger";
import { publicOrigin } from "./app-origin";
import { getStripe, isSandbox } from "./stripe-client";
import { remove, selectOne, upsert } from "./store";
import type { WebhookEndpointKind } from "./webhooks";

const EVENTS = {
  platform: ["account.application.deauthorized"],
  connect: [
    "account.updated", "capability.updated", "invoice.created", "invoice.paid", "invoice.payment_failed",
    "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
    "invoice.finalized", "charge.refunded", "refund.updated",
    "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
    "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated", "payout.paid", "payout.failed",
    "payment_intent.payment_failed",
  ],
} as const;
const secretCache = new Map<WebhookEndpointKind, string>();
const RETRY_MS = 5 * 60_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let registered = false;
let lastError: string | null = null;
let lastCheckedAt: string | null = null;
let healthCache: { expires: number; value: BillingWebhookHealth } | null = null;
export interface BillingWebhookHealth {
  registered: boolean;
  endpoints: Array<{ kind: WebhookEndpointKind; url: string; enabled_events: number; status: string }>;
  last_error: string | null;
  last_checked_at: string | null;
}
function endpointUrl(kind: WebhookEndpointKind): string {
  return `${publicOrigin()}/api/billing/webhooks/${kind}`;
}
const WORKSPACE_HOST_SUFFIX = ".replit.dev";
const SIBLING_MIN_AGE_MS = 60 * 60_000;
const LIVENESS_TIMEOUT_MS = 5_000;
function parseUrl(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}
/** A workspace counts as alive only when its own health route answers. Dead domains 404 or refuse. */
async function workspaceIsAlive(host: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${host}/api/healthz`, { signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS), redirect: "manual" });
    return res.ok;
  } catch {
    return false;
  }
}
/**
 * Every workspace that boots this server against the shared Stripe sandbox
 * registers endpoints on its own temporary `.replit.dev` domain (task agents
 * run in throwaway workspaces). Those domains die with the workspace, Stripe
 * keeps retrying them, and eventually emails about the failures. A running
 * sandbox workspace deletes sibling endpoints whose workspace no longer
 * answers its health route. Guards: sandbox keys only, `.replit.dev` hosts
 * only (production origins are never touched), at least an hour old so a
 * sibling that is still booting is left alone, and a live health check so two
 * running workspaces never delete each other.
 */
export async function pruneStaleWorkspaceEndpoints(
  stripe: Stripe, kind: WebhookEndpointKind, now = Date.now(), isAlive: (host: string) => Promise<boolean> = workspaceIsAlive,
): Promise<number> {
  const current = new URL(endpointUrl(kind));
  if (!current.host.endsWith(WORKSPACE_HOST_SUFFIX) || !(await isSandbox())) return 0;
  const candidates: Stripe.WebhookEndpoint[] = [];
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    const target = parseUrl(endpoint.url);
    if (!target || target.host === current.host || !target.host.endsWith(WORKSPACE_HOST_SUFFIX) || target.pathname !== current.pathname) continue;
    if (now - endpoint.created * 1000 < SIBLING_MIN_AGE_MS) continue;
    candidates.push(endpoint);
  }
  const liveness = new Map<string, boolean>();
  let pruned = 0;
  for (const endpoint of candidates) {
    const host = new URL(endpoint.url).host;
    if (!liveness.has(host)) liveness.set(host, await isAlive(host));
    if (liveness.get(host)) continue;
    await stripe.webhookEndpoints.del(endpoint.id);
    await remove("billing_webhook_endpoints", `url=eq.${encodeURIComponent(endpoint.url)}`).catch(() => undefined);
    logger.info({ kind, url: endpoint.url }, "deleted stale billing webhook endpoint from a retired workspace");
    pruned += 1;
  }
  return pruned;
}
export async function getEndpointSecret(kind: WebhookEndpointKind): Promise<string> {
  const cached = secretCache.get(kind);
  if (cached) return cached;
  const row = await selectOne("billing_webhook_endpoints", `url=eq.${encodeURIComponent(endpointUrl(kind))}`);
  if (!row?.secret) throw new Error(`Billing ${kind} webhook is not configured.`);
  secretCache.set(kind, row.secret);
  return row.secret;
}
async function savedEndpointIsLive(stripe: Stripe, endpointId: string | null | undefined): Promise<boolean> {
  if (!endpointId) return false;
  try {
    const endpoint = await stripe.webhookEndpoints.retrieve(endpointId);
    return endpoint.status === "enabled";
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === "resource_missing") return false;
    throw error;
  }
}
export async function ensureEndpoint(kind: WebhookEndpointKind): Promise<void> {
  const url = endpointUrl(kind);
  const saved = await selectOne("billing_webhook_endpoints", `url=eq.${encodeURIComponent(url)}`);
  const stripe = await getStripe();
  // A saved row only proves an endpoint existed on the account that was connected when it was written.
  // Re-keying the Stripe connection leaves the row behind with a secret the new account never issued.
  if (saved?.secret && (await savedEndpointIsLive(stripe, saved.stripe_endpoint_id))) {
    secretCache.set(kind, saved.secret);
    await pruneQuietly(stripe, kind);
    return;
  }
  if (saved?.secret) logger.warn({ kind, url }, "saved billing webhook endpoint is missing in Stripe; re-registering");
  secretCache.delete(kind);
  const listed = await stripe.webhookEndpoints.list({ limit: 100 });
  for (const endpoint of listed.data.filter((candidate) => candidate.url === url)) {
    await stripe.webhookEndpoints.del(endpoint.id);
  }
  const created = await stripe.webhookEndpoints.create({
    url, enabled_events: [...EVENTS[kind]],
    ...(kind === "connect" ? { connect: true } : {}),
  });
  if (!created.secret) throw new Error("Stripe did not return a webhook signing secret.");
  await upsert("billing_webhook_endpoints", {
    kind, url, stripe_endpoint_id: created.id, secret: created.secret, livemode: !(await isSandbox()),
  }, "url");
  secretCache.set(kind, created.secret);
  await pruneQuietly(stripe, kind);
}
async function pruneQuietly(stripe: Stripe, kind: WebhookEndpointKind): Promise<void> {
  try {
    await pruneStaleWorkspaceEndpoints(stripe, kind);
  } catch (error) {
    logger.warn({ err: error, kind }, "stale billing webhook endpoint prune failed");
  }
}
let inFlight: Promise<void> | null = null;
/** Single-flight: startup, the retry timer, and the reconcile job can overlap; two registrations would mint two secrets. */
export function ensureBillingWebhookEndpoints(): Promise<void> {
  if (process.env.BILLING_WEBHOOKS_DISABLED === "1" || process.env.NODE_ENV === "test") return Promise.resolve();
  if (!inFlight) inFlight = ensureAll().finally(() => { inFlight = null; });
  return inFlight;
}
async function ensureAll(): Promise<void> {
  try {
    await ensureEndpoint("platform"); await ensureEndpoint("connect");
    registered = true; lastError = null; lastCheckedAt = new Date().toISOString();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  } catch (error) {
    registered = false;
    lastError = error instanceof Error ? error.message : "Unknown Stripe error";
    lastCheckedAt = new Date().toISOString();
    logger.error({ err: error }, "billing webhook endpoint setup failed; retrying in 5 minutes");
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void ensureBillingWebhookEndpoints();
      }, RETRY_MS);
      retryTimer.unref?.();
    }
  }
}

export function stopBillingWebhookEndpointRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

export async function getBillingWebhookHealth(): Promise<BillingWebhookHealth> {
  if (healthCache && healthCache.expires > Date.now()) return healthCache.value;
  const endpoints: BillingWebhookHealth["endpoints"] = [];
  try {
    const stripe = await getStripe();
    for (const kind of ["platform", "connect"] as const) {
      const url = endpointUrl(kind);
      const saved = await selectOne("billing_webhook_endpoints", `url=eq.${encodeURIComponent(url)}`);
      let status = "missing";
      let enabledEvents = 0;
      if (saved?.stripe_endpoint_id) {
        try {
          const endpoint = await stripe.webhookEndpoints.retrieve(saved.stripe_endpoint_id);
          status = endpoint.status;
          enabledEvents = endpoint.enabled_events.length;
        } catch (error) {
          if (!(error instanceof Stripe.errors.StripeError) || error.code !== "resource_missing") throw error;
        }
      }
      endpoints.push({ kind, url, enabled_events: enabledEvents, status });
    }
    registered = endpoints.every((endpoint) => endpoint.status === "enabled");
    lastError = null;
  } catch (error) {
    registered = false;
    lastError = error instanceof Error ? error.message : "Unknown Stripe error";
  }
  lastCheckedAt = new Date().toISOString();
  const value = { registered, endpoints, last_error: lastError, last_checked_at: lastCheckedAt };
  healthCache = { expires: Date.now() + RETRY_MS, value };
  return value;
}