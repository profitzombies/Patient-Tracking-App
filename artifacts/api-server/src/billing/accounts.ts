import crypto from "node:crypto";
import type Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase-admin";
import { publicOrigin } from "./app-origin";
import { connectedOpts, getConnectClientId, getPublishableKey, getStripe, isSandbox } from "./stripe-client";
import { insert, nowIso, selectOne, update, type BillingConnectedAccountRow } from "./store";
import type { AccountRequirements, ConnectedAccount, DashboardType } from "./types";
import { onStripeEvent } from "./webhooks";
import { currentBillingIdentity, runWithBillingIdentity, type BillingIdentity } from "./stripe-environment";
import { claimConnect, connectGuard } from "./connect-guard";

export class BillingAccountError extends Error {
  constructor(message: string, readonly status = 400, readonly unsupported?: string[]) { super(message); }
}

type Provider = {
  provider_id: string; provider_name: string | null; office_name: string | null; email: string | null;
  phone: string | null; address_line_1: string | null; address_line_2: string | null;
  city: string | null; state: string | null; postal_code: string | null;
};

async function provider(providerId: string): Promise<Provider> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=provider_id,provider_name,office_name,email,phone,address_line_1,address_line_2,city,state,postal_code&limit=1`,
  );
  const row = Array.isArray(result.json) ? result.json[0] as Provider | undefined : undefined;
  if (result.status >= 300 || !row) throw new BillingAccountError("That office was not found.", 404);
  return row;
}

function requirements(account: Stripe.Account): AccountRequirements {
  return {
    currently_due: account.requirements?.currently_due ?? [],
    past_due: account.requirements?.past_due ?? [],
    eventually_due: account.requirements?.eventually_due ?? [],
    disabled_reason: account.requirements?.disabled_reason ?? null,
    current_deadline: account.requirements?.current_deadline
      ? new Date(account.requirements.current_deadline * 1000).toISOString() : null,
  };
}

function dashboardType(account: Stripe.Account): DashboardType {
  const controlled = account.controller?.stripe_dashboard?.type;
  if (controlled === "none" || controlled === "full" || controlled === "express") return controlled as DashboardType;
  return account.type === "standard" ? "full" : account.type === "express" ? "express" : "none";
}

/**
 * THINNR sends every customer email itself, so Stripe's own customer emails
 * (receipts, invoice and renewal notices) must stay off. Stripe exposes no API
 * for those Dashboard toggles: an account without Dashboard access can never
 * turn them on ("off" by construction), while an account with its own
 * Dashboard stays "unverified" until HQ confirms it, or an earlier confirmation
 * is carried forward unchanged.
 */
export function stripeCustomerEmailsPatch(
  account: Pick<Stripe.Account, "type">, existing?: Pick<BillingConnectedAccountRow, "stripe_customer_emails" | "stripe_customer_emails_checked_at" | "stripe_customer_emails_note"> | null,
): Pick<BillingConnectedAccountRow, "stripe_customer_emails" | "stripe_customer_emails_checked_at" | "stripe_customer_emails_note"> {
  if (dashboardType(account as Stripe.Account) === "none") {
    return {
      stripe_customer_emails: "off", stripe_customer_emails_checked_at: nowIso(),
      stripe_customer_emails_note: "No Stripe Dashboard: Stripe customer emails cannot be enabled on this account.",
    };
  }
  if (existing?.stripe_customer_emails && existing.stripe_customer_emails !== "unverified" && existing.stripe_customer_emails_checked_at) {
    return {
      stripe_customer_emails: existing.stripe_customer_emails, stripe_customer_emails_checked_at: existing.stripe_customer_emails_checked_at,
      stripe_customer_emails_note: existing.stripe_customer_emails_note ?? null,
    };
  }
  return {
    stripe_customer_emails: "unverified", stripe_customer_emails_checked_at: null,
    stripe_customer_emails_note: "This account has its own Stripe Dashboard. Turn off Settings → Emails → Customer emails (successful payments, refunds, upcoming renewals), then confirm here.",
  };
}

function accountPatch(account: Stripe.Account, existing?: BillingConnectedAccountRow | null) {
  return {
    ...stripeCustomerEmailsPatch(account, existing),
    stripe_account_id: account.id,
    dashboard_type: dashboardType(account),
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    details_submitted: Boolean(account.details_submitted),
    requirements: requirements(account) as unknown as Record<string, unknown>,
    capabilities: (account.capabilities ?? {}) as unknown as Record<string, string>,
    default_currency: account.default_currency ?? null,
    business_name: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? null,
    email: account.email ?? null,
  };
}

export function toConnectedAccount(row: BillingConnectedAccountRow): ConnectedAccount {
  const req = row.requirements as unknown as Partial<AccountRequirements>;
  return {
    provider_id: row.provider_id, stripe_account_id: row.stripe_account_id, origin: row.origin,
    dashboard_type: row.dashboard_type, charges_enabled: row.charges_enabled, payouts_enabled: row.payouts_enabled,
    details_submitted: row.details_submitted,
    requirements: {
      currently_due: req.currently_due ?? [], past_due: req.past_due ?? [],
      eventually_due: req.eventually_due ?? [], disabled_reason: req.disabled_reason ?? null,
      current_deadline: req.current_deadline ?? null,
    },
    capabilities: row.capabilities, default_currency: row.default_currency, business_name: row.business_name,
    email: row.email, tax_enabled: row.tax_enabled, livemode: row.livemode,
    stripe_customer_emails: row.stripe_customer_emails ?? "unverified",
    stripe_customer_emails_checked_at: row.stripe_customer_emails_checked_at ?? null,
    stripe_customer_emails_note: row.stripe_customer_emails_note ?? null,
    last_synced_at: row.last_synced_at, disconnected_at: row.disconnected_at, created_at: row.created_at,
  };
}

/** Stripe's merchant category for health and beauty spas — what a med spa is. */
export const MED_SPA_MCC = "7298";

/**
 * Everything THINNR already knows about the office, pre-filled into the new
 * connected account so Stripe's onboarding opens with it filled in.
 *
 * Only account-level fields and `business_profile` are sent. A `company` or
 * `individual` block would force `business_type`, which the office chooses in
 * Stripe's onboarding (sole proprietors are individuals, most med spas are
 * companies) — sending one would make that choice for them. THINNR keeps no
 * practice website, so `business_profile.url` is left for the office to add.
 */
export function inAppAccountPrefill(office: Provider): Pick<Stripe.AccountCreateParams, "country" | "email" | "default_currency" | "business_profile"> {
  const supportAddress = office.address_line_1 && office.city && office.state && office.postal_code
    ? { line1: office.address_line_1, line2: office.address_line_2 ?? undefined, city: office.city,
        state: office.state, postal_code: office.postal_code, country: "US" }
    : undefined;
  const name = office.office_name?.trim() || office.provider_name?.trim() || undefined;
  return {
    country: "US",
    email: office.email ?? undefined,
    default_currency: "usd",
    business_profile: {
      name,
      mcc: MED_SPA_MCC,
      product_description: `${name ?? "Med spa"} sells aesthetic and wellness services and products to its patients through THINNR.`,
      support_email: office.email ?? undefined,
      support_phone: office.phone ?? undefined,
      support_address: supportAddress,
    },
  };
}

export async function createInAppAccount(providerId: string, actorUserId: string): Promise<ConnectedAccount> {
  const existing = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`);
  if (existing) throw new BillingAccountError("This office already has a Stripe account. Use the safe restart workflow or contact HQ.", 409);
  const claim=await claimConnect(providerId);
  const office = await provider(providerId);
  const stripe = await getStripe();
  const account = await stripe.accounts.create({
    ...inAppAccountPrefill(office),
    controller: {
      stripe_dashboard: { type: "none" },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { thinnr_provider_id: providerId },
  }, { idempotencyKey: `account:v4:${providerId}:${currentBillingIdentity()!.mode}:${currentBillingIdentity()!.platformAccountId}:${claim.generation}` });
  await connectGuard("attach",providerId,{p_token:claim.token,p_generation:claim.generation,p_version:claim.modeVersion,p_account:{
    provider_id: providerId, origin: "created", oauth_refresh_token: null, disconnected_at: null,
    tax_enabled: false, tax_last_checked_at: null, last_synced_at: nowIso(), livemode: !(await isSandbox()),
    terminal_location_id: null, terminal_location_checked_at: null,
    ...accountPatch(account),
  }});
  const row=await selectOne("billing_connected_accounts",`provider_id=eq.${encodeURIComponent(providerId)}`);
  if (!row) throw new BillingAccountError("Connection was not saved. Contact HQ.",503);
  await insert("billing_account_events", {
    provider_id: providerId, kind: "account_created", detail: { actor_user_id: actorUserId },
  });
  return toConnectedAccount(row);
}

function stateSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new BillingAccountError("OAuth is not configured.", 503);
  return secret;
}
function signState(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
function verifyState(state: string): { provider_id: string; actor: string; exp: number; identity: BillingIdentity; generation:number; modeVersion:number } {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw new BillingAccountError("The connection link is invalid or expired.", 400);
  const expected = crypto.createHmac("sha256", stateSecret()).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new BillingAccountError("The connection link is invalid or expired.", 400);
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as { provider_id?: string; actor?: string; exp?: number; identity?: BillingIdentity; generation?:number; modeVersion?:number };
  if (!payload.provider_id || !payload.actor || !payload.exp || payload.exp < Date.now() ||
      !payload.identity || !["test", "live"].includes(payload.identity.mode) || !/^acct_[A-Za-z0-9]+$/.test(payload.identity.platformAccountId)) {
    throw new BillingAccountError("The connection link is invalid or expired.", 400);
  }
  if (!Number.isSafeInteger(payload.generation) || !Number.isSafeInteger(payload.modeVersion)) throw new BillingAccountError("Restart this expired connection link.",409);
  return payload as { provider_id: string; actor: string; exp: number; identity: BillingIdentity; generation:number; modeVersion:number };
}

export async function buildOauthStartUrl(providerId: string, actorUserId: string): Promise<string> {
  const identity = currentBillingIdentity();
  if (!identity) throw new BillingAccountError("Payment mode must be selected before connecting Stripe.", 503);
  const clientId = getConnectClientId();
  if (!clientId) throw new BillingAccountError("Stripe OAuth is not configured.", 503);
  const office = await provider(providerId);
  const attempt=await connectGuard("start",providerId);
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, scope: "read_write",
    state: signState({ provider_id: providerId, actor: actorUserId, identity, generation:attempt.generation, modeVersion:attempt.modeVersion, exp: Date.now() + 15 * 60_000 }),
    redirect_uri: `${publicOrigin()}/api/billing/oauth/callback`,
  });
  if (office.email) query.set("stripe_user[email]", office.email);
  return `https://connect.stripe.com/oauth/authorize?${query}`;
}

export async function completeOauth(code: string, state: string): Promise<ConnectedAccount> {
  const payload = verifyState(state);
  return runWithBillingIdentity(payload.identity, async () => {
  const claim=await claimConnect(payload.provider_id,payload.generation,payload.modeVersion);
  const stripe = await getStripe();
  const token = await stripe.oauth.token({ grant_type: "authorization_code", code });
  if (token.livemode !== (payload.identity.mode === "live")) throw new BillingAccountError("Stripe returned an account in the wrong payment mode.", 409);
  if (!token.stripe_user_id) throw new BillingAccountError("Stripe did not return an account.", 502);
  const account = await stripe.accounts.retrieve(token.stripe_user_id);
  if (account.deleted) throw new BillingAccountError("That Stripe account is unavailable.", 409);
  await connectGuard("attach",payload.provider_id,{p_token:claim.token,p_generation:claim.generation,p_version:claim.modeVersion,p_account:{
    provider_id: payload.provider_id, origin: "oauth", oauth_refresh_token: token.refresh_token ?? null,
    disconnected_at: null, tax_enabled: false, tax_last_checked_at: null, last_synced_at: nowIso(),
    livemode: !(await isSandbox()), terminal_location_id: null, terminal_location_checked_at: null,
    ...accountPatch(account),
  }});
  await insert("billing_account_events", {
    provider_id: payload.provider_id, kind: "oauth_connected", detail: { actor_user_id: payload.actor },
  });
  return syncAccount(payload.provider_id);
  });
}

export const ACCOUNT_COMPONENTS = [
  "account_onboarding", "account_management", "payouts", "balances", "payments", "tax_settings",
  "tax_registrations", "notification_banner", "documents", "payment_details", "disputes_list", "payment_disputes",
] as const;
export type AccountComponent = typeof ACCOUNT_COMPONENTS[number];

export async function createAccountSession(providerId: string, components: AccountComponent[]) {
  const row = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}&disconnected_at=is.null`);
  if (!row) throw new BillingAccountError("Connect a Stripe account first.", 409);
  const requested = [...new Set(components)];
  if (requested.some((component) => !ACCOUNT_COMPONENTS.includes(component))) {
    throw new BillingAccountError("An unsupported account component was requested.", 400);
  }
  const paymentFeatures = { dispute_management: true, refund_management: true, capture_payments: false };
  const enabled = Object.fromEntries(requested.map((component) => [
    component,
    component === "disputes_list" || component === "payments" || component === "payment_details"
      ? { enabled: true, features: paymentFeatures } : { enabled: true },
  ]));
  try {
    const session = await (await getStripe()).accountSessions.create(
      { account: row.stripe_account_id, components: enabled } as Stripe.AccountSessionCreateParams,
    );
    await insert("billing_account_events", { provider_id: providerId, kind: "onboarding_started", detail: { components: requested } });
    return { client_secret: session.client_secret, publishable_key: await getPublishableKey(), sandbox: await isSandbox(), stripe_account_id: row.stripe_account_id };
  } catch (error) {
    if (row.dashboard_type === "full") {
      throw new BillingAccountError("These tools are not available for this Stripe account.", 409, requested);
    }
    throw error;
  }
}

async function event(providerId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  await insert("billing_account_events", { provider_id: providerId, kind, detail });
}

export async function syncAccount(providerId: string): Promise<ConnectedAccount> {
  const before = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`);
  if (!before) throw new BillingAccountError("Connect a Stripe account first.", 404);
  const stripe = await getStripe();
  const account = await stripe.accounts.retrieve(before.stripe_account_id);
  if (account.deleted) throw new BillingAccountError("That Stripe account is unavailable.", 409);
  let taxEnabled = before.tax_enabled;
  try {
    const tax = await stripe.tax.settings.retrieve({}, connectedOpts(before.stripe_account_id));
    taxEnabled = tax.status === "active";
  } catch {
    // Account status remains useful when Tax has not been enabled for the account.
  }
  const patch = { ...accountPatch(account, before), tax_enabled: taxEnabled, tax_last_checked_at: nowIso(), last_synced_at: nowIso() };
  const after = await update("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`, patch);
  if (!after) throw new BillingAccountError("Connected account could not be updated.", 502);
  if (!before.charges_enabled && after.charges_enabled) await event(providerId, "charges_enabled", {});
  if (!before.payouts_enabled && after.payouts_enabled) await event(providerId, "payouts_enabled", {});
  if (JSON.stringify(before.requirements) !== JSON.stringify(after.requirements)) await event(providerId, "requirements_updated", after.requirements);
  if (JSON.stringify(before.capabilities) !== JSON.stringify(after.capabilities)) await event(providerId, "capability_updated", after.capabilities);
  if (before.tax_enabled !== after.tax_enabled) await event(providerId, after.tax_enabled ? "tax_enabled" : "tax_disabled", {});
  return toConnectedAccount(after);
}

async function providerByStripeAccount(accountId: string): Promise<string | null> {
  return (await selectOne("billing_connected_accounts", `stripe_account_id=eq.${encodeURIComponent(accountId)}`))?.provider_id ?? null;
}

export function registerAccountWebhookHandlers(): void {
  const sync = async (_event: Stripe.Event, ctx: { account: string | null }) => {
    const accountId = ctx.account ?? (_event.data.object as { id?: string }).id ?? null;
    if (!accountId) return;
    const providerId = await providerByStripeAccount(accountId);
    if (providerId) await syncAccount(providerId);
  };
  onStripeEvent("account.updated", sync);
  onStripeEvent("capability.updated", sync);
  onStripeEvent("account.application.deauthorized", async (stripeEvent) => {
    const accountId = (stripeEvent.data.object as { id?: string }).id;
    if (!accountId) return;
    const providerId = await providerByStripeAccount(accountId);
    if (!providerId) return;
    await update("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`, { disconnected_at: nowIso() });
    await event(providerId, "deauthorized", {});
  });
}
/** HQ attests that Stripe's customer emails are off (or reports them on) for an account with its own Dashboard. */
export async function recordStripeCustomerEmails(providerId: string, state: "off" | "on", actorUserId: string): Promise<ConnectedAccount> {
  const row = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`);
  if (!row) throw new BillingAccountError("This office has no connected Stripe account.", 404);
  if (row.dashboard_type === "none") throw new BillingAccountError("Stripe cannot email this account's customers; nothing to confirm.", 409);
  const updated = await update("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`, {
    stripe_customer_emails: state, stripe_customer_emails_checked_at: nowIso(),
    stripe_customer_emails_note: state === "off"
      ? "Confirmed off in the office's Stripe Dashboard."
      : "Stripe is emailing this office's customers. Turn off Settings → Emails → Customer emails in the office's Stripe Dashboard.",
  });
  if (!updated) throw new BillingAccountError("Connected account could not be updated.", 502);
  await event(providerId, "customer_emails_recorded", { state, by: actorUserId });
  return toConnectedAccount(updated);
}
