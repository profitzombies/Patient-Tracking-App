import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingModeStatus } from "../billing/mode-state";
import { currentBillingIdentity, type BillingIdentity, runWithBillingIdentity } from "../billing/stripe-environment";
import { selectOne } from "../billing/store";
import { accessGateSatisfied } from "../billing/office-access/setup";

export async function readModeCompletion(providerId:string,identity:BillingIdentity) {
  const result=await supabaseAdmin("GET",`/rest/v1/practice_launch_completions?provider_id=eq.${encodeURIComponent(providerId)}&stripe_mode=eq.${identity.mode}&platform_account_id=eq.${encodeURIComponent(identity.platformAccountId)}&select=completed_at&limit=1`);
  if(result.status>=300||!Array.isArray(result.json)) throw new Error("Practice setup completion unavailable.");
  return result.json[0]?.completed_at as string|undefined;
}

/**
 * Whether the office may use the workspace at all.
 *
 * Two independent arrangements must both be in place: the office can take
 * money from its patients (its connected Stripe account, confirmed in the
 * current billing identity) AND it has put its own money arrangements with
 * THINNR on file (bank account, two distinct cards, plan, disclosure). Either
 * one missing keeps the office on the setup screen.
 */
export async function operationalLaunchComplete(providerId:string) {
  // HQ can deliberately waive the gate for one office (demonstration and
  // support accounts can never connect real money). The waiver lives on the
  // launch row; removing it puts the real gate straight back.
  if ((await readLaunch(providerId)).setup_override_at) return true;
  const identity=currentBillingIdentity()??await getBillingModeStatus();
  const completed=await readModeCompletion(providerId,identity);
  if(!completed) return false;
  const account=await runWithBillingIdentity(identity,()=>selectOne("billing_connected_accounts",`provider_id=eq.${encodeURIComponent(providerId)}`));
  if (!paymentsLaunchSatisfied(paymentLaunchState(account))) return false;
  return runWithBillingIdentity(identity,()=>accessGateSatisfied(providerId));
}

export async function readLaunch(providerId: string) {
  const result = await supabaseAdmin("GET", `/rest/v1/practice_launch?provider_id=eq.${encodeURIComponent(providerId)}&limit=1`);
  if (result.status >= 300 || !Array.isArray(result.json) || !result.json[0]) {
    throw new Error("Practice setup is unavailable.");
  }
  return result.json[0] as {required:boolean;version:number;details_confirmed:boolean;products_confirmed:boolean;completed_at:string|null;setup_override_at?:string|null;setup_override_note?:string|null};
}

/**
 * Setup/security/help remain reachable while operational deep links fail
 * closed. `/billing/office/access` is how an office gets THROUGH the gate — it
 * carries the bank account, cards, plan and disclosure — so it is open too.
 */
export function isLaunchAllowedPath(url: string) {
  const path = url.split("?")[0].replace(/^\/api/, "");
  return /^\/office\/launch(?:\/|$)/.test(path)
    || /^\/(?:security|staff-session|auth|claim)(?:\/|$)/.test(path)
    || /^\/billing\/office\/(?:status|connect|access)(?:\/|$)/.test(path);
}

/**
 * Whether the office's Stripe connection is far enough along to open the
 * workspace. Stripe still verifying submitted details ("pending") counts: the
 * office has done everything it can, and patient charges stay blocked on their
 * own until Stripe enables them (checkout checks charges_enabled).
 */
export function paymentsLaunchSatisfied(state: ReturnType<typeof paymentLaunchState>): boolean {
  return state === "ready" || state === "pending";
}

export function paymentLaunchState(account: {details_submitted:boolean;charges_enabled:boolean;payouts_enabled:boolean;requirements:Record<string,unknown>;disconnected_at?:string|null} | null) {
  if (!account) return "not_started" as const;
  if (account.disconnected_at) return "action_required" as const;
  const due = ["currently_due","past_due"].some(key => Array.isArray(account.requirements[key]) && (account.requirements[key] as unknown[]).length > 0);
  if (!account.details_submitted || due) return "action_required" as const;
  // A disabled/rejected account is never ready or "verification pending",
  // whatever its stored charge/payout flags say.
  const reason = account.requirements.disabled_reason;
  if (reason && reason !== "requirements.pending_verification") return "action_required" as const;
  if (account.charges_enabled && account.payouts_enabled) return "ready" as const;
  return "pending" as const;
}