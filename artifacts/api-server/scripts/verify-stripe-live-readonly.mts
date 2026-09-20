/**
 * Read-only verification of the live Stripe platform configuration.
 *
 * This script deliberately uses only Stripe GET/list operations plus an
 * unauthenticated GET of Stripe's OAuth authorize page. It never creates,
 * updates, deletes, confirms, refunds, registers, or accepts anything.
 * Output is intentionally sanitized: no keys, client IDs, account IDs,
 * endpoint URLs, redirect query strings, balances, or Stripe object IDs.
 */
import type Stripe from "stripe";
import { BILLING_WEBHOOK_EVENTS } from "../src/billing/webhook-endpoints";
import { getStripe, getStripeCredentials } from "../src/billing/stripe-client";

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
const limitations = [
  "Webhook destination listing proves configuration visibility, not event delivery or successful signature processing.",
  "Stripe's webhook endpoint response does not reliably expose whether a destination listens to connected-account events; confirm source scope in the Dashboard.",
  "The OAuth probe proves only that Stripe accepts a read-only authorize-page request; it does not complete OAuth, onboarding, terms acceptance, or account activation.",
];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[redacted key]")
    .replace(/\bwhsec_\S+/g, "[redacted webhook secret]")
    .replace(/\bca_[A-Za-z0-9]+\b/g, "[redacted client id]")
    .replace(/\bacct_[A-Za-z0-9]+\b/g, "[redacted account id]")
    .replace(/https?:\/\/\S+/g, "[redacted URL]");
}

function liveOrigin(): string {
  const configured = process.env.BILLING_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (!configured) throw new Error("BILLING_PUBLIC_ORIGIN is missing.");
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BILLING_PUBLIC_ORIGIN must be a plain HTTPS origin.");
  }
  return parsed.origin;
}

function liveClientId(): string {
  const value = process.env.STRIPE_LIVE_CONNECT_CLIENT_ID?.trim();
  if (!value) throw new Error("STRIPE_LIVE_CONNECT_CLIENT_ID is missing.");
  if (!/^ca_[A-Za-z0-9]+$/.test(value)) throw new Error("STRIPE_LIVE_CONNECT_CLIENT_ID has an invalid shape.");
  return value;
}

async function retrieveSelf(stripe: Stripe): Promise<Stripe.Account> {
  // The SDK runtime supports GET /v1/account, while the generated declaration
  // only describes GET /v1/accounts/:id.
  const retrieve = stripe.accounts.retrieve as unknown as () => Promise<Stripe.Account>;
  return retrieve.call(stripe.accounts);
}

async function main(): Promise<void> {
  const credentials = await getStripeCredentials("live");
  check("Live credential shapes", credentials.secret.startsWith("sk_live_")
    && credentials.publishable.startsWith("pk_live_")
    && /^acct_[A-Za-z0-9]+$/.test(credentials.account_id),
  "Live secret, publishable key, and configured platform account have the expected shapes; values were not printed.");

  const clientId = liveClientId();
  check("Live Connect client ID", true, "Configured and has the expected ca_ shape; value was not printed.");

  // getStripe("live") performs the canonical read-only self-account identity
  // verification before returning the client.
  const stripe = await getStripe("live");
  const [platform, balance] = await Promise.all([
    retrieveSelf(stripe),
    stripe.balance.retrieve(),
  ]);
  check("Authenticated live platform identity", platform.id === credentials.account_id && balance.livemode === true,
    platform.id === credentials.account_id && balance.livemode === true
      ? "GET /v1/account matched the configured platform and GET /v1/balance reported live mode; IDs and amounts were not printed."
      : "The authenticated platform did not match the configured live identity or balance did not report live mode.");
  check("Platform account readiness", Boolean(platform.charges_enabled && platform.payouts_enabled && platform.details_submitted),
    `charges_enabled=${Boolean(platform.charges_enabled)}, payouts_enabled=${Boolean(platform.payouts_enabled)}, details_submitted=${Boolean(platform.details_submitted)}.`);
  const capabilityStates = Object.values(platform.capabilities ?? {});
  const inactiveCapabilities = capabilityStates.filter((status) => status !== "active").length;
  check("Platform capabilities", capabilityStates.length > 0 && inactiveCapabilities === 0,
    `Stripe returned ${capabilityStates.length} capability record(s); ${inactiveCapabilities} are not active. Capability names and account ID were not printed.`);
  check("Live balance access", balance.livemode === true,
    `Read-only live balance retrieval succeeded; ${balance.available.length} available and ${balance.pending.length} pending currency bucket(s) were present, with no amounts printed.`);

  const origin = liveOrigin();
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 });
  for (const kind of ["platform", "connect"] as const) {
    const expectedUrl = `${origin}/api/billing/webhooks/live/${kind}`;
    const matches = endpoints.filter((endpoint) => endpoint.url === expectedUrl);
    const enabled = matches.find((endpoint) => endpoint.status === "enabled");
    const required = [...BILLING_WEBHOOK_EVENTS[kind]];
    const missing = enabled
      ? required.filter((event) => !enabled.enabled_events.includes(event as Stripe.WebhookEndpoint.EnabledEvent))
      : required;
    check(`Live ${kind} webhook destination`, matches.length === 1 && Boolean(enabled) && missing.length === 0,
      matches.length === 0
        ? `No destination matched the configured production origin; ${required.length} required event(s) remain unverified.`
        : `Found ${matches.length} matching destination(s); enabled=${Boolean(enabled)}, required-events=${required.length}, missing-required-events=${missing.length}. URLs and endpoint IDs were not printed.`);
  }

  const authorize = new URL("https://connect.stripe.com/oauth/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    redirect_uri: `${origin}/api/billing/oauth/callback`,
    state: "live-readonly-verification-no-user-action",
  }).toString();
  const oauthResponse = await fetch(authorize, { method: "GET", redirect: "manual" });
  const location = oauthResponse.headers.get("location");
  let expectedStripePage = false;
  let redirectPath = "none";
  if (location) {
    const target = new URL(location, authorize);
    redirectPath = target.hostname === "connect.stripe.com" ? target.pathname : "non-Stripe";
    expectedStripePage = oauthResponse.status >= 300 && oauthResponse.status < 400
      && target.hostname === "connect.stripe.com"
      && target.pathname.startsWith("/oauth/");
  }
  check("Live Connect OAuth authorize probe", expectedStripePage,
    expectedStripePage
      ? `Stripe redirected the GET-only probe to its OAuth flow (path=${redirectPath}); no query string or client ID was logged and no authorization action was taken.`
      : `GET-only authorize probe did not redirect to the expected Stripe OAuth flow (HTTP ${oauthResponse.status}, path=${redirectPath}).`);
}

try {
  await main();
} catch (error) {
  check("Harness completion", false, safeError(error));
}

console.log(JSON.stringify({
  mode: "live-read-only",
  generated_at: new Date().toISOString(),
  operations: [
    "GET authenticated platform account",
    "GET live balance",
    "LIST webhook destinations",
    "GET OAuth authorize page without following or submitting",
  ],
  checks,
  limitations,
  writes_attempted: 0,
}, null, 2));
process.exitCode = checks.some((item) => !item.ok) ? 1 : 0;