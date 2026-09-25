import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { resolveOfficeScope, type OfficeScope } from "../auth/office-scope";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingModeStatus } from "../billing/mode-state";
import { runWithBillingIdentity, currentBillingIdentity } from "../billing/stripe-environment";
import { selectOne } from "../billing/store";
import { syncAccount } from "../billing/accounts";
import { AccountInput } from "./provider-accounts";
import { paymentLaunchState, paymentsLaunchSatisfied, readLaunch, readModeCompletion } from "../practice-launch/state";
import { accessGateFacts } from "../billing/office-access/setup";
import { currentSecondFactorPolicy, loadStaffSecondFactor, secondFactorRequiredByPolicy } from "../auth/second-factor";
import { autoconfirmLaunchProducts, getLaunchProducts, saveLaunchProducts, LaunchProductsError } from "../practice-launch/products";

const router: IRouter = Router();
const enc = encodeURIComponent;
const Details = AccountInput.pick({officeName:true,providerName:true,email:true,phone:true,address1:true,address2:true,city:true,state:true,postalCode:true});
const Version = z.number().int().nonnegative();
async function rpc(name:string, body:Record<string,unknown>) {
  const result = await supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
  if (result.status >= 300) throw new LaunchProductsError(result.json?.message ?? "Setup could not be saved.",result.json?.code === "40001" ? 409 : 400);
}
type LaunchRow = Awaited<ReturnType<typeof readLaunch>>;
/**
 * Setup is only complete when BOTH directions of money are arranged: the
 * office can charge its patients (connected account) and THINNR can charge
 * the office (bank account, two cards, plan, disclosure). An HQ waiver opens
 * the workspace without pretending any of that is in place: every other field
 * of the snapshot still reports what is actually missing.
 */
/** Comfortably inside complete_practice_launch's two-minute freshness window. */
const COMPLETE_SYNC_FRESH_MS=90_000;
function recentlySynced(at:unknown):boolean {
  const ms=typeof at==="string" ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && Date.now()-ms<COMPLETE_SYNC_FRESH_MS;
}

function launchCompletedAt(launch:LaunchRow, payments:ReturnType<typeof paymentLaunchState>, accessSatisfied:boolean, modeCompletion:string|undefined) {
  return launch.setup_override_at ?? (paymentsLaunchSatisfied(payments) && accessSatisfied ? modeCompletion??null : null);
}
function overrideOf(launch:LaunchRow) {
  return {active:Boolean(launch.setup_override_at),at:launch.setup_override_at??null,note:launch.setup_override_note??null};
}
async function snapshot(scope:OfficeScope) {
  const identity=currentBillingIdentity()!;
  const [launch,provider,account,products,receipts,policy,factor,modeCompletion,access] = await Promise.all([
    readLaunch(scope.providerId),
    supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(scope.providerId)}&select=office_name,provider_name,email,phone,address_line_1,address_line_2,city,state,postal_code&limit=1`),
    selectOne("billing_connected_accounts", `provider_id=eq.${enc(scope.providerId)}`),
    getLaunchProducts(scope.providerId),
    supabaseAdmin("GET",`/rest/v1/practice_launch_product_receipts?provider_id=eq.${enc(scope.providerId)}&stripe_mode=eq.${identity.mode}&platform_account_id=eq.${enc(identity.platformAccountId)}&select=expected_version&limit=1`),
    currentSecondFactorPolicy(),
    scope.actorKind==="hq" ? Promise.resolve(null) : loadStaffSecondFactor(scope.actorKind,scope.teamMemberId??scope.providerId),
    readModeCompletion(scope.providerId,identity),
    accessGateFacts(scope.providerId),
  ]);
  if (provider.status >= 300 || receipts.status>=300 || !provider.json?.[0]) throw new Error("Practice details unavailable.");
  const phoneRequired=scope.actorKind!=="hq" && secondFactorRequiredByPolicy(policy,{class:scope.actorKind,officeRole:scope.officeRole});
  const phoneVerified=Boolean(factor?.verifiedAt);
  const securityReady=scope.actorKind==="hq" || !phoneRequired || phoneVerified;
  const row = provider.json[0];
  return {
    office:{providerId:scope.providerId,officeName:scope.officeName},canEdit:scope.actorKind === "provider",
    // HQ is inspecting someone else's office: it can read this screen but can
    // never confirm anything on it, so it is not held behind the gate.
    hqInspection:scope.actorKind === "hq",
    billingScope:`${identity.mode}:${identity.platformAccountId}`,
    required:true,fullSetupRequired:launch.required,version:launch.version,detailsConfirmed:launch.details_confirmed,
    productsConfirmed:launch.products_confirmed&&receipts.json.length>0,
    completedAt:launchCompletedAt(launch,paymentLaunchState(account),access.satisfied,modeCompletion),
    setupOverride:overrideOf(launch),
    accessSetup:{
      complete:access.satisfied,
      missing:access.status.missing,
      planSelected:access.planSelected,
      disclosureAcknowledged:access.disclosureAcknowledged,
      bankVerificationPending:access.status.bankVerificationPending,
      bankVerificationDeadline:access.status.bankVerificationDeadline,
      bankVerificationOverdue:access.status.bankVerificationOverdue,
    },
    details:{officeName:row.office_name??"",providerName:row.provider_name??"",email:row.email??"",phone:row.phone??"",address1:row.address_line_1??"",address2:row.address_line_2??"",city:row.city??"",state:row.state??"",postalCode:row.postal_code??""},
    // Facts about the VIEWER's own sign-in. Staff always sign in with an
    // emailed code, so reaching this route proves the email. Only the last
    // four digits of the verified phone ever leave the API.
    security:{
      ready:securityReady,emailVerified:true,phoneVerified,phoneRequired,
      phoneMasked:phoneVerified&&factor?.phone ? `(•••) •••-${String(factor.phone).slice(-4)}` : null,
    },payments:{state:paymentLaunchState(account),sandbox:identity.mode !== "live"},
    products,
  };
}

/**
 * The snapshot after first-time full setup has had its suggested prices saved.
 * Only the office's own people trigger the write (an HQ read stays free of
 * side effects), and only while the products item is still open, so settled
 * offices pay nothing extra. A failed write never fails the read: the office
 * simply sees products as still open and the next read tries again.
 */
async function settled(scope:OfficeScope, req:Request) {
  const state=await snapshot(scope);
  if (scope.actorKind==="hq" || !state.fullSetupRequired || state.productsConfirmed || !scope.actorUserId) return state;
  try {
    const result=await autoconfirmLaunchProducts(scope.providerId,scope.actorUserId);
    if (!result?.applied) return state;
  } catch(error) {
    req.log?.warn({err:error},"suggested launch prices were not saved");
    return state;
  }
  return snapshot(scope);
}

router.use("/office/launch", async (req,res,next) => {
  try {
    const mode = await getBillingModeStatus();
    res.setHeader("Cache-Control","no-store");
    runWithBillingIdentity(mode,next);
  } catch { res.status(503).json({error:"Payment configuration is unavailable. Setup was not changed."}); }
});
const HQ_ONLY = new Set(["regate","override"]);
async function handle(req:Request,res:Response,kind:"read"|"details"|"products"|"complete"|"regate"|"override") {
  try {
    const resolved = await resolveOfficeScope({authorization:req.headers.authorization,request:req,explicitOfficeId:typeof req.query.office === "string" ? req.query.office : null,hqPermission:HQ_ONLY.has(kind)?"provider_manage":"provider_read",requireUnlocked:kind!=="read"});
    if (resolved.kind!=="ok") { res.status(resolved.status).json({error:resolved.message});return; }
    const scope = resolved.scope;
    if (HQ_ONLY.has(kind) ? scope.actorKind!=="hq" : kind!=="read" && scope.actorKind!=="provider") {
      res.status(403).json({error:"Only the practice owner can confirm setup. HQ inspection is read-only."});return;
    }
    if (kind==="products" || kind==="complete") {
      const identity=currentBillingIdentity()!;
      if (req.get("X-Billing-Scope")!==`${identity.mode}:${identity.platformAccountId}`) {
        res.status(409).json({error:"Payment mode changed. Reload setup before confirming.",code:"billing_scope_changed"});return;
      }
    }
    if (kind==="details") {
      const input = z.object({expectedVersion:Version,details:Details}).parse(req.body);
      await rpc("save_practice_launch_details",{p_provider_id:scope.providerId,p_expected_version:input.expectedVersion,p_details:input.details});
    }
    if (kind==="products") {
      const input = z.object({expectedVersion:Version,products:z.array(z.object({productId:z.string().uuid(),enabled:z.boolean(),sellPriceCents:z.number().int().nonnegative(),subscriptionEnabled:z.boolean()}))}).parse(req.body);
      await saveLaunchProducts(scope.providerId,scope.actorUserId,input.expectedVersion,input.products);
    }
    if (kind==="complete") {
      const input=z.object({expectedVersion:Version}).parse(req.body);
      const account=await selectOne("billing_connected_accounts",`provider_id=eq.${enc(scope.providerId)}`);
      // Re-read Stripe when the stored account does not satisfy setup yet (its
      // webhook may simply not have landed) or when the stored read is too old
      // for the completion RPC, which demands a Stripe read from the last two
      // minutes. A recent, satisfying read spares the click a Stripe round-trip.
      if (account && (!paymentsLaunchSatisfied(paymentLaunchState(account)) || !recentlySynced(account.last_synced_at))) await syncAccount(scope.providerId);
      const state=await settled(scope,req);
      if (!state.security.ready) throw new LaunchProductsError("Complete the required account security in Security settings.");
       if (state.fullSetupRequired && !state.productsConfirmed) throw new LaunchProductsError("Confirm product prices in the current payment mode.");
       if (!paymentsLaunchSatisfied(state.payments.state)) throw new LaunchProductsError("Finish Stripe's steps for your connected account before setup can be confirmed.");
       if (!state.accessSetup.complete) throw new LaunchProductsError(state.accessSetup.bankVerificationOverdue
         ? "Your bank account was not verified in time. Verify it or add a different account before finishing setup."
         : "Add your bank account, both credit cards, a billing plan and accept the access terms before finishing setup.");
      const identity=currentBillingIdentity()!;
      await rpc("complete_practice_launch",{p_provider_id:scope.providerId,p_expected_version:input.expectedVersion,p_stripe_mode:identity.mode,p_platform_account_id:identity.platformAccountId});
      // Completing changes only the launch row and this mode's completion, so
      // re-read just those instead of rebuilding the whole snapshot.
      const [launch,modeCompletion]=await Promise.all([readLaunch(scope.providerId),readModeCompletion(scope.providerId,identity)]);
      res.json({...state,version:launch.version,
        completedAt:launchCompletedAt(launch,state.payments.state,state.accessSetup.complete,modeCompletion),
        setupOverride:overrideOf(launch)});
      return;
    }
    if (kind==="regate") {
      const input=z.object({expectedVersion:Version}).strict().parse(req.body);
      await rpc("regate_practice_launch",{p_provider_id:scope.providerId,p_expected_version:input.expectedVersion,p_actor:scope.actorUserId});
    }
    if (kind==="override") {
      // HQ waives the gate for one office; the office itself can never ask for
      // this, and nothing the office already confirmed is changed or lost.
      const input=z.object({expectedVersion:Version,enabled:z.boolean(),note:z.string().max(280).optional()}).strict().parse(req.body);
      await rpc("set_practice_launch_override",{p_provider_id:scope.providerId,p_expected_version:input.expectedVersion,p_actor:scope.actorUserId,p_enabled:input.enabled,p_note:input.note??null});
    }
    res.json(await settled(scope,req));
  } catch(error) {
    if(error instanceof z.ZodError) {res.status(400).json({error:error.issues[0]?.message??"Check the form."});return;}
    if(error instanceof LaunchProductsError) {res.status(error.status).json({error:error.message});return;}
    req.log?.error({err:error},"practice launch request failed");
    res.status(503).json({error:"Practice setup is unavailable. Your progress was not confirmed; refresh and retry."});
  }
}
router.get("/office/launch",(req,res)=>handle(req,res,"read"));
router.put("/office/launch/details",(req,res)=>handle(req,res,"details"));
router.post("/office/launch/products",(req,res)=>handle(req,res,"products"));
router.post("/office/launch/complete",(req,res)=>handle(req,res,"complete"));
router.post("/office/launch/regate",(req,res)=>handle(req,res,"regate"));
router.post("/office/launch/override",(req,res)=>handle(req,res,"override"));
export default router;
