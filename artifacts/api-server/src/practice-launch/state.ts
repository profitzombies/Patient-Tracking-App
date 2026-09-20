import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingModeStatus } from "../billing/mode-state";
import { currentBillingIdentity, type BillingIdentity, runWithBillingIdentity } from "../billing/stripe-environment";
import { selectOne } from "../billing/store";

export async function readModeCompletion(providerId:string,identity:BillingIdentity) {
  const result=await supabaseAdmin("GET",`/rest/v1/practice_launch_completions?provider_id=eq.${encodeURIComponent(providerId)}&stripe_mode=eq.${identity.mode}&platform_account_id=eq.${encodeURIComponent(identity.platformAccountId)}&select=completed_at&limit=1`);
  if(result.status>=300||!Array.isArray(result.json)) throw new Error("Practice setup completion unavailable.");
  return result.json[0]?.completed_at as string|undefined;
}

export async function operationalLaunchComplete(providerId:string) {
  const identity=currentBillingIdentity()??await getBillingModeStatus();
  const completed=await readModeCompletion(providerId,identity);
  if(!completed) return false;
  const account=await runWithBillingIdentity(identity,()=>selectOne("billing_connected_accounts",`provider_id=eq.${encodeURIComponent(providerId)}`));
  return ["pending","ready"].includes(paymentLaunchState(account));
}

export async function readLaunch(providerId: string) {
  const result = await supabaseAdmin("GET", `/rest/v1/practice_launch?provider_id=eq.${encodeURIComponent(providerId)}&limit=1`);
  if (result.status >= 300 || !Array.isArray(result.json) || !result.json[0]) {
    throw new Error("Practice setup is unavailable.");
  }
  return result.json[0] as {required:boolean;version:number;details_confirmed:boolean;products_confirmed:boolean;completed_at:string|null};
}

/** Setup/security/help remain reachable while operational deep links fail closed. */
export function isLaunchAllowedPath(url: string) {
  const path = url.split("?")[0].replace(/^\/api/, "");
  return /^\/office\/launch(?:\/|$)/.test(path)
    || /^\/(?:security|staff-session|auth|claim)(?:\/|$)/.test(path)
    || /^\/billing\/office\/(?:status|connect)(?:\/|$)/.test(path);
}

export function paymentLaunchState(account: {details_submitted:boolean;charges_enabled:boolean;payouts_enabled:boolean;requirements:Record<string,unknown>} | null) {
  if (!account) return "not_started" as const;
  const due = ["currently_due","past_due"].some(key => Array.isArray(account.requirements[key]) && (account.requirements[key] as unknown[]).length > 0);
  if (!account.details_submitted || due) return "action_required" as const;
  if (account.charges_enabled && account.payouts_enabled) return "ready" as const;
  // A disabled/rejected account is not "external verification pending".
  const reason = account.requirements.disabled_reason;
  if (reason && reason !== "requirements.pending_verification") return "action_required" as const;
  return "pending" as const;
}