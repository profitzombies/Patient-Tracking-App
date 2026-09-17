import Stripe from "stripe";
import { logger } from "../lib/logger";
import { supabaseAdmin } from "../lib/supabase-admin";
import { connectedOpts, getStripe } from "./stripe-client";
import { nowIso, selectOne, update, type BillingConnectedAccountRow } from "./store";
import type { TapSettlementBlock, TapToPayAvailability, TapToPayUnavailableReason, TerminalConnectionToken } from "./types";

/**
 * Stripe Terminal plumbing for Tap to Pay on the provider's phone.
 *
 * Every office's connected account is the merchant, so Terminal objects live
 * on that account: one location per office (minted from the office's own
 * address the first time it is needed) and connection tokens scoped to it.
 * The phone registers itself as a Tap to Pay reader against the location from
 * the SDK, so no reader rows exist server-side.
 */
export class BillingTerminalError extends Error {
  constructor(message: string, readonly status = 400, readonly reason: TapToPayUnavailableReason | TapSettlementBlock | null = null) { super(message); }
}

type OfficeAddress = {
  office_name: string | null; provider_name: string | null; address_line_1: string | null; address_line_2: string | null;
  city: string | null; state: string | null; postal_code: string | null;
};

async function officeAddress(providerId: string): Promise<OfficeAddress | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=office_name,provider_name,address_line_1,address_line_2,city,state,postal_code&limit=1`,
  );
  const row = Array.isArray(result.json) ? result.json[0] as OfficeAddress | undefined : undefined;
  return result.status < 300 && row ? row : null;
}

function completeAddress(office: OfficeAddress | null): office is OfficeAddress & { address_line_1: string; city: string; state: string; postal_code: string } {
  return Boolean(office?.address_line_1?.trim() && office.city?.trim() && office.state?.trim() && office.postal_code?.trim());
}

async function connectedAccount(providerId: string): Promise<BillingConnectedAccountRow> {
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}&disconnected_at=is.null`);
  if (!account?.charges_enabled) throw new BillingTerminalError("Your office is not set up to take payments in the app yet.", 409, "not_connected");
  return account;
}

function terminalRejected(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeError)) return false;
  // Terminal not enabled / not available for the account's country or type:
  // Stripe answers 400/403 invalid_request, never a 5xx or a rate limit.
  return error.type === "StripeInvalidRequestError" || error.type === "StripePermissionError";
}

/**
 * The office's Terminal location, created on first use. Stripe requires a
 * postal address, so an office without one cannot take Tap to Pay until it is
 * filled in (surfaced as `no_office_address`, never a silent default address).
 */
export async function ensureTerminalLocation(providerId: string, account?: BillingConnectedAccountRow): Promise<{ account: BillingConnectedAccountRow; locationId: string }> {
  const row = account ?? await connectedAccount(providerId);
  const stripe = await getStripe();
  const acct = row.stripe_account_id;
  if (row.terminal_location_id) {
    try {
      const existing: any = await stripe.terminal.locations.retrieve(row.terminal_location_id, {}, connectedOpts(acct));
      if (!existing?.deleted) return { account: row, locationId: existing.id };
    } catch (error) {
      if (!terminalRejected(error)) throw error;
      logger.warn({ err: error, providerId }, "stored terminal location is gone; minting a new one");
    }
  }
  const office = await officeAddress(providerId);
  if (!completeAddress(office)) throw new BillingTerminalError("Add your office's street address in Settings before taking Tap to Pay payments.", 409, "no_office_address");
  let location: any;
  try {
    location = await stripe.terminal.locations.create({
      display_name: (office.office_name ?? office.provider_name ?? "Office").slice(0, 100),
      address: {
        line1: office.address_line_1.trim(), line2: office.address_line_2?.trim() || undefined, city: office.city.trim(),
        state: office.state.trim(), postal_code: office.postal_code.trim(), country: "US",
      },
      metadata: { thinnr_provider_id: providerId },
    }, connectedOpts(acct, `terminal-location:${acct}:${row.terminal_location_checked_at ? Date.parse(row.terminal_location_checked_at) : "first"}`));
  } catch (error) {
    if (terminalRejected(error)) {
      logger.warn({ err: error, providerId }, "stripe terminal is not available on this office's account");
      throw new BillingTerminalError("Tap to Pay is not enabled on your office's Stripe account yet.", 409, "terminal_unavailable");
    }
    throw error;
  }
  const updated = await update("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}&stripe_account_id=eq.${encodeURIComponent(acct)}`, {
    terminal_location_id: location.id, terminal_location_checked_at: nowIso(),
  });
  return { account: updated ?? { ...row, terminal_location_id: location.id }, locationId: location.id };
}

/** Whether this office can take Tap to Pay at all, without minting anything. */
export async function tapToPayAvailability(providerId: string, account: BillingConnectedAccountRow | null): Promise<TapToPayAvailability> {
  if (!account?.charges_enabled || account.disconnected_at) return { available: false, reason: "not_connected" };
  if (account.terminal_location_id) return { available: true, reason: null };
  const office = await officeAddress(providerId);
  return completeAddress(office) ? { available: true, reason: null } : { available: false, reason: "no_office_address" };
}

/** A short-lived Terminal connection token for the office's account, plus the location the phone should register at. */
export async function createConnectionToken(providerId: string): Promise<TerminalConnectionToken> {
  const { account, locationId } = await ensureTerminalLocation(providerId);
  const stripe = await getStripe();
  try {
    const token = await stripe.terminal.connectionTokens.create({ location: locationId }, connectedOpts(account.stripe_account_id));
    return { secret: token.secret, location_id: locationId, stripe_account_id: account.stripe_account_id };
  } catch (error) {
    if (terminalRejected(error)) throw new BillingTerminalError("Tap to Pay is not enabled on your office's Stripe account yet.", 409, "terminal_unavailable");
    throw error;
  }
}
