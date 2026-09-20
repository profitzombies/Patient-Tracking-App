import { supabaseAdmin } from "../lib/supabase-admin";
import { getPlatformAccountId, getStripe } from "./stripe-client";
import type { BillingIdentity, StripeMode } from "./stripe-environment";

export class BillingModeError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}
export interface BillingModeStatus extends BillingIdentity { version: number }
function deploymentId(): string {
  const value = process.env.BILLING_DEPLOYMENT_ID?.trim();
  if (!value) throw new BillingModeError("BILLING_DEPLOYMENT_ID must be configured before using billing.");
  return value;
}
/** Selection metadata is readable even while Stripe credentials are missing. */
export async function getBillingModeSelection(): Promise<{ mode: StripeMode; version: number; platformAccountId: string | null }> {
  const result = await supabaseAdmin("GET", `/rest/v1/billing_mode_state?deployment_id=eq.${encodeURIComponent(deploymentId())}&limit=1`);
  if (result.status >= 300) throw new BillingModeError("Billing mode could not be loaded.");
  const row = Array.isArray(result.json) ? result.json[0] : null;
  const mode: StripeMode = row?.mode ?? "test";
  if (mode !== "test" && mode !== "live") throw new BillingModeError("Billing mode is invalid.");
  return { mode, platformAccountId: row?.platform_account_id ?? null, version: row?.version ?? 0 };
}
export async function getBillingModeStatus(): Promise<BillingModeStatus> {
  const selection = await getBillingModeSelection();
  const platformAccountId = await getPlatformAccountId(selection.mode);
  if (selection.platformAccountId && selection.platformAccountId !== platformAccountId) {
    throw new BillingModeError("The configured Stripe account changed. Review billing configuration before continuing.");
  }
  return { ...selection, platformAccountId };
}
export async function switchBillingMode(input: {
  mode: StripeMode; expectedVersion: number; confirmLive: boolean; actorUserId: string; requestId: string | null;
}): Promise<BillingModeStatus> {
  if (input.mode !== "test" && input.mode !== "live") throw new BillingModeError("Choose Test or Live.", 400);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new BillingModeError("Reload the billing mode before switching.", 409);
  if (input.mode === "live" && input.confirmLive !== true) throw new BillingModeError("Confirm that Live mode uses real money.", 400);
  // Verify the key belongs to the configured platform before persisting selection.
  await getStripe(input.mode);
  const platformAccountId = await getPlatformAccountId(input.mode);
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/switch_billing_mode", {
    p_deployment_id: deploymentId(), p_mode: input.mode, p_platform_account_id: platformAccountId,
    p_expected_version: input.expectedVersion, p_confirm_live: input.confirmLive,
    p_actor_user_id: input.actorUserId, p_request_id: input.requestId,
  });
  if (result.status >= 300) {
    if (result.json?.code === "40001") throw new BillingModeError("Billing mode changed. Reload before switching.", 409);
    throw new BillingModeError("Billing mode could not be changed.");
  }
  const row = Array.isArray(result.json) ? result.json[0] : result.json;
  return { mode: row.mode, platformAccountId: row.platform_account_id, version: row.version };
}