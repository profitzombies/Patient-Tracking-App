import crypto from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";
import { currentBillingIdentity } from "./stripe-environment";
import { getBillingModeStatus } from "./mode-state";
import { connectedOpts, getStripe } from "./stripe-client";
import { selectOne } from "./store";

export class ConnectGuardError extends Error {
  constructor(message:string, readonly status=409) { super(message); }
}
export async function connectGuard(action:string, providerId:string, extra:Record<string,unknown>={}) {
  const identity=currentBillingIdentity();
  if (!identity) throw new ConnectGuardError("Payment identity unavailable.",503);
  const selected=await getBillingModeStatus();
  if (selected.mode!==identity.mode || selected.platformAccountId!==identity.platformAccountId)
    throw new ConnectGuardError("Payment mode changed. Reload before connecting.");
  const result=await supabaseAdmin("POST","/rest/v1/rpc/guard_office_connect",{
    p_provider_id:providerId,p_mode:identity.mode,p_platform:identity.platformAccountId,
    p_deployment:process.env.BILLING_DEPLOYMENT_ID,p_action:action,p_version:selected.version,...extra,
  });
  if(result.status>=300) throw new ConnectGuardError(result.json?.message??"Connection is locked. Contact HQ support.",result.status>=500?503:409);
  return result.json as {generation:number;token:string;modeVersion:number};
}
export async function claimConnect(providerId:string,generation?:number,modeVersion?:number) {
  const token=crypto.randomUUID();
  return connectGuard("claim",providerId,{p_generation:generation??null,p_token:token,...(modeVersion===undefined?{}:{p_version:modeVersion})});
}
/** Remote reads fail closed. Never delete, deauthorize or clear a Stripe account. */
export async function restartConnect(providerId:string) {
  const lock=await connectGuard("restart_claim",providerId,{p_token:crypto.randomUUID()});
  try {
    const row=await selectOne("billing_connected_accounts",`provider_id=eq.${encodeURIComponent(providerId)}`);
    if(row) {
      const stripe=await getStripe();
      const account=await stripe.accounts.retrieve(row.stripe_account_id);
      if(account.deleted || account.charges_enabled || account.payouts_enabled || account.details_submitted ||
          account.requirements?.pending_verification?.length)
        throw new ConnectGuardError("This account is already enabled or unavailable. Contact HQ support; it cannot be replaced here.");
      const opts=connectedOpts(row.stripe_account_id);
      const [balance,charges,intents,subscriptions,payouts,transactions]=await Promise.all([
        stripe.balance.retrieve({},opts),stripe.charges.list({limit:1},opts),
        stripe.paymentIntents.list({limit:1},opts),stripe.subscriptions.list({limit:1,status:"all"},opts),
        stripe.payouts.list({limit:1},opts),stripe.balanceTransactions.list({limit:1},opts),
      ]);
      if([...balance.available,...balance.pending].some(b=>b.amount!==0) ||
          charges.data.length || intents.data.length || subscriptions.data.length || payouts.data.length || transactions.data.length)
        throw new ConnectGuardError("Financial activity exists. Contact HQ support; this connection must be preserved.");
    }
    await connectGuard("restart_commit",providerId,{p_token:lock.token,p_generation:lock.generation,p_version:lock.modeVersion});
  } catch(error) {
    // Releasing a restart lock is safe: no remote mutation was performed.
    await connectGuard("release",providerId,{p_token:lock.token}).catch(()=>{});
    throw error;
  }
}