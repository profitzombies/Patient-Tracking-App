/**
 * Office app-access settings: whether the office charges patients for the
 * app's premium AI features, at what price and cadence, and how long a
 * non-THINNR patient's free trial runs.
 *
 * The settings live on the shared office settings row (one truth across
 * payment identities, versioned like the shipping override). The recurring
 * Stripe price is a per-identity mirror on the office's CONNECTED account —
 * see ensureAppAccessPrice — refreshed on every save and lazily at checkout,
 * so a price edit is live for the next patient without a second step.
 */
import { BillingCatalogError, recordCatalogChange } from "../catalog";
import { APP_ACCESS_THINNR_SHARE_PERCENT } from "../fees";
import {
  insertIgnore, selectOne, update, type AppAccessCadence, type BillingAppAccessPriceRow, type BillingOfficeSettingsRow,
} from "../store";
import { connectedOpts, getStripe, isStripeMissing } from "../stripe-client";
import type { AppAccessOfficeSettings } from "./entitlement";

const enc = encodeURIComponent;

export const DEFAULT_APP_ACCESS_TRIAL_DAYS = 7;
export const APP_ACCESS_CADENCES: readonly AppAccessCadence[] = ["2_weeks", "monthly"];
/** Stripe rejects recurring prices under $0.50. */
export const MIN_APP_ACCESS_PRICE_CENTS = 50;
export const MAX_APP_ACCESS_PRICE_CENTS = 100_000_000;
export const MAX_APP_ACCESS_TRIAL_DAYS = 365;

/** What the office screens read and write. */
export interface OfficeAppAccessSettings {
  enabled: boolean;
  price_cents: number | null;
  cadence: AppAccessCadence;
  trial_days: number;
  version: number;
  updated_at: string | null;
  /** The share THINNR keeps of every app-access charge (informational; set by HQ policy). */
  thinnr_share_percent: number;
}

export interface OfficeAppAccessSettingsInput {
  enabled: boolean;
  price_cents: number | null;
  cadence: AppAccessCadence;
  trial_days: number;
  expected_version: number;
}

export function cadenceLabel(cadence: AppAccessCadence): string {
  return cadence === "2_weeks" ? "every 2 weeks" : "monthly";
}

/** The Stripe recurring interval for a cadence. */
export function cadenceInterval(cadence: AppAccessCadence): { interval: "week" | "month"; interval_count: number } {
  return cadence === "2_weeks" ? { interval: "week", interval_count: 2 } : { interval: "month", interval_count: 1 };
}

/** How the subscription row records the cadence (display only; renewals follow Stripe). */
export function cadenceWeeks(cadence: AppAccessCadence): number {
  return cadence === "2_weeks" ? 2 : 4;
}

/** The entitlement-rule view of a settings row (absent row = the defaults: not charging, 7-day trial). */
export function officeSettingsFacts(row: Pick<BillingOfficeSettingsRow,
  "app_access_enabled" | "app_access_price_cents" | "app_access_cadence" | "app_access_trial_days"> | null | undefined,
): AppAccessOfficeSettings {
  return {
    enabled: row?.app_access_enabled === true,
    price_cents: typeof row?.app_access_price_cents === "number" ? row.app_access_price_cents : null,
    cadence: row?.app_access_cadence === "2_weeks" ? "2_weeks" : "monthly",
    trial_days: typeof row?.app_access_trial_days === "number" ? row.app_access_trial_days : DEFAULT_APP_ACCESS_TRIAL_DAYS,
  };
}

export async function getOfficeAppAccessSettings(providerId: string): Promise<OfficeAppAccessSettings> {
  const row = await selectOne("billing_office_settings", `provider_id=eq.${enc(providerId)}`);
  return toDto(row);
}

function toDto(row: BillingOfficeSettingsRow | null): OfficeAppAccessSettings {
  const facts = officeSettingsFacts(row);
  return {
    enabled: facts.enabled, price_cents: facts.price_cents, cadence: facts.cadence, trial_days: facts.trial_days,
    version: row?.version ?? 0, updated_at: row?.updated_at ?? null,
    thinnr_share_percent: APP_ACCESS_THINNR_SHARE_PERCENT,
  };
}
export function validateAppAccessSettings(input: OfficeAppAccessSettingsInput): void {
  if (!APP_ACCESS_CADENCES.includes(input.cadence)) throw new BillingCatalogError("Choose every 2 weeks or monthly.", 400, "cadence");
  if (!Number.isInteger(input.trial_days) || input.trial_days < 0 || input.trial_days > MAX_APP_ACCESS_TRIAL_DAYS) {
    throw new BillingCatalogError(`The free trial must be between 0 and ${MAX_APP_ACCESS_TRIAL_DAYS} days.`, 400, "trial_days");
  }
  if (input.price_cents !== null) {
    if (!Number.isInteger(input.price_cents) || input.price_cents < MIN_APP_ACCESS_PRICE_CENTS || input.price_cents > MAX_APP_ACCESS_PRICE_CENTS) {
      throw new BillingCatalogError("Enter a price of at least $0.50.", 400, "price_cents");
    }
  }
  if (input.enabled && input.price_cents === null) throw new BillingCatalogError("Set a price before charging for the app.", 400, "price_cents");
}

/**
 * Versioned write (409 on a stale version). When charging is on, the Stripe
 * price is mirrored before the row is saved so an office never advertises a
 * price patients cannot pay; a Stripe failure leaves the settings untouched.
 */
export async function updateOfficeAppAccessSettings(
  providerId: string, input: OfficeAppAccessSettingsInput, actor: string,
): Promise<OfficeAppAccessSettings> {
  validateAppAccessSettings(input);
  const before = await selectOne("billing_office_settings", `provider_id=eq.${enc(providerId)}`);
  const currentVersion = before?.version ?? 0;
  if (currentVersion !== input.expected_version) throw new BillingCatalogError("App access settings changed. Refresh and try again.", 409);
  if (input.enabled && input.price_cents !== null) {
    await ensureAppAccessPrice(providerId, { price_cents: input.price_cents, cadence: input.cadence });
  }
  const columns = {
    app_access_enabled: input.enabled, app_access_price_cents: input.price_cents,
    app_access_cadence: input.cadence, app_access_trial_days: input.trial_days,
  };
  let after: BillingOfficeSettingsRow | null;
  if (!before) {
    after = await insertIgnore("billing_office_settings",
      { provider_id: providerId, pick_pack_pass_through: null, ...columns, version: 1, updated_by: actor }, "billing_office_settings_pkey");
  } else {
    after = await update("billing_office_settings", `provider_id=eq.${enc(providerId)}&version=eq.${currentVersion}`, {
      ...columns, version: currentVersion + 1, updated_by: actor,
    });
  }
  if (!after) throw new BillingCatalogError("App access settings changed. Refresh and try again.", 409);
  await recordCatalogChange({
    productId: null, kind: "office_app_access_settings_updated", actor, providerId,
    before: before ? { ...officeSettingsFacts(before) } : null, after: { ...officeSettingsFacts(after) },
  });
  return toDto(after);
}

export class AppAccessPriceError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/**
 * The office's app-access price on its connected account, created or
 * replaced so that it matches `target` (amount + cadence). Mirrored ids only
 * mean something on the account they were created on: an office that
 * reconnects a different Stripe account gets fresh objects and the stale ones
 * are left alone. Old prices are archived, never deleted, so existing
 * subscriptions keep billing at the price they started on.
 */
export async function ensureAppAccessPrice(
  providerId: string, target: { price_cents: number; cadence: AppAccessCadence },
): Promise<BillingAppAccessPriceRow> {
  const [mirror, account] = await Promise.all([
    selectOne("billing_app_access_prices", `provider_id=eq.${enc(providerId)}`),
    selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}&disconnected_at=is.null`),
  ]);
  if (!account?.charges_enabled) throw new AppAccessPriceError("Connect Stripe and finish setup before charging for the app.", 409);
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  let stripeProductId = mirror?.stripe_product_id ?? null;
  let productFresh = false;
  if (stripeProductId) {
    try { await stripe.products.retrieve(stripeProductId, {}, connectedOpts(acct)); }
    catch (error) { if (!isStripeMissing(error)) throw error; stripeProductId = null; }
  }
  if (!stripeProductId) {
    const product = await stripe.products.create(
      { name: "THINNR app premium features", metadata: { thinnr_app_access: "true", thinnr_provider_id: providerId } },
      connectedOpts(acct, `app-access-product:${providerId}:${acct}`),
    );
    stripeProductId = product.id;
    productFresh = true;
  }
  const interval = cadenceInterval(target.cadence);
  let priceId = mirror?.stripe_price_id ?? null;
  let priceOnAccount = false;
  let replace = true;
  if (priceId && !productFresh) {
    try {
      const current = await stripe.prices.retrieve(priceId, {}, connectedOpts(acct));
      priceOnAccount = true;
      replace = !current.active || current.unit_amount !== target.price_cents
        || current.recurring?.interval !== interval.interval || current.recurring?.interval_count !== interval.interval_count;
    } catch (error) {
      if (!isStripeMissing(error)) throw error;
      replace = true;
    }
  }
  if (replace) {
    const oldId = priceOnAccount ? priceId : null;
    const created = await stripe.prices.create({
      product: stripeProductId, currency: "usd", unit_amount: target.price_cents,
      recurring: interval, metadata: { thinnr_app_access: "true", thinnr_cadence: target.cadence },
    }, connectedOpts(acct, `app-access-price:${providerId}:${target.price_cents}:${target.cadence}:${oldId ?? "initial"}:${acct}`));
    priceId = created.id;
    if (oldId && oldId !== created.id) await stripe.prices.update(oldId, { active: false }, connectedOpts(acct));
  }
  const columns = { price_cents: target.price_cents, cadence: target.cadence, stripe_product_id: stripeProductId, stripe_price_id: priceId };
  if (!mirror) {
    const inserted = await insertIgnore("billing_app_access_prices", { provider_id: providerId, ...columns }, "billing_app_access_prices_provider_key");
    if (inserted) return inserted;
  }
  const saved = await update("billing_app_access_prices", `provider_id=eq.${enc(providerId)}`, columns);
  if (!saved) throw new AppAccessPriceError("The app access price could not be saved.", 503);
  return saved;
}
