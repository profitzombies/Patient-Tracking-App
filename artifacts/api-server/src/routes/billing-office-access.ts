/**
 * The office's own payment setup with THINNR: the bank account and two cards
 * it keeps on file, the plan it chose, and the disclosure it accepted.
 *
 * These routes are reachable while the setup gate is closed (see
 * `isLaunchAllowedPath`) — they are how an office gets through it. Every one
 * of them is scoped to the caller's own office; HQ may read but never act.
 *
 * Card and bank details never reach this server: the browser talks to Stripe
 * directly through a SetupIntent and hands back only the resulting payment
 * method id.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope } from "../auth/office-scope";
import { getBillingModeStatus } from "../billing/mode-state";
import { currentBillingIdentity, runWithBillingIdentity } from "../billing/stripe-environment";
import { getPublishableKey, getStripe, isSandbox, stripeRejection } from "../billing/stripe-client";
import { selectOne, type BillingOfficeAccessSubscriptionRow } from "../billing/store";
import { paymentLaunchState } from "../practice-launch/state";
import {
  AccessInstrumentError, attachAccessInstrument, ensureAccessCustomer,
} from "../billing/office-access/instruments";
import {
  AccessSetupError, accessSetupSnapshot, acknowledgeAccessDisclosure,
  refreshBankVerification, selectAccessPlan,
} from "../billing/office-access/setup";
import { ensureAccessSubscription, type AccessActor } from "../billing/office-access/subscription";
import { defaultBillingDetails, loadOfficeIdentity } from "../billing/office-access/customer-identity";
import { chargeOfficeAccess } from "../billing/office-access/charge";
import { requestIdOf } from "../lib/admin-audit";

const router: IRouter = Router();
const enc = encodeURIComponent;
const Slot = z.enum(["bank", "card_primary", "card_backup"]);
const Plan = z.enum(["monthly", "yearly"]);

/** Instruments are the office's own money: HQ inspects, staff act. */
function actorOf(scope: OfficeScope, req: Request): AccessActor {
  return {
    kind: scope.actorKind === "hq" ? "hq" : scope.actorKind,
    userId: scope.actorUserId,
    requestId: requestIdOf(req),
  };
}

/**
 * The connected-account side of the snapshot. Writes start these reads before
 * they write, so they overlap with the write instead of queuing behind it.
 * Rejections are parked so an early start never surfaces as unhandled when
 * the write itself fails first.
 */
interface ConnectContext { connect: Promise<ReturnType<typeof paymentLaunchState>>; sandbox: Promise<boolean> }
function connectContext(scope: OfficeScope): ConnectContext {
  const connect = selectOne("billing_connected_accounts", `provider_id=eq.${enc(scope.providerId)}`).then(paymentLaunchState);
  const sandbox = isSandbox();
  connect.catch(() => undefined); sandbox.catch(() => undefined);
  return { connect, sandbox };
}

/**
 * The setup snapshot every access route answers with, so the screen can show
 * the new state straight from the write's own response. `row` is the
 * subscription row a write just returned, which spares a re-read.
 */
async function snapshotFor(scope: OfficeScope, context: ConnectContext = connectContext(scope), row?: BillingOfficeAccessSubscriptionRow | null): Promise<Awaited<ReturnType<typeof accessSetupSnapshot>>> {
  return accessSetupSnapshot({
    providerId: scope.providerId,
    officeName: scope.officeName,
    connect: context.connect,
    sandbox: context.sandbox,
    row: row ?? undefined,
    // Any office staff member may fix a card or settle a balance from their
    // phone; only the owner may choose the plan or accept the terms.
    canManage: scope.actorKind !== "hq",
    canChoosePlan: scope.actorKind === "provider",
  });
}

function answerError(req: Request, res: Response, error: unknown): void {
  if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues[0]?.message ?? "Check the form." }); return; }
  if (error instanceof AccessInstrumentError || error instanceof AccessSetupError) {
    res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    return;
  }
  const rejected = stripeRejection(error);
  if (rejected) { res.status(rejected.status).json({ error: rejected.message }); return; }
  req.log?.error({ err: error }, "office access setup request failed");
  res.status(503).json({ error: "Payment setup is unavailable. Nothing was changed; refresh and retry." });
}

router.use("/billing/office/access", async (req, res, next) => {
  try {
    const mode = await getBillingModeStatus();
    res.setHeader("Cache-Control", "no-store");
    runWithBillingIdentity(mode, next);
  } catch { res.status(503).json({ error: "Payment configuration is unavailable. Setup was not changed." }); }
});

/**
 * Resolve the caller's office for this surface. `write` refuses HQ (read-only
 * here) and `owner` additionally refuses anyone but the practice owner.
 */
async function scoped(
  req: Request, res: Response, level: "read" | "staff" | "owner",
): Promise<OfficeScope | null> {
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: "financial_read",
    requireUnlocked: level !== "read",
  });
  if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return null; }
  const scope = resolved.scope;
  if (level !== "read" && scope.actorKind === "hq") {
    res.status(403).json({ error: "HQ can review payment setup but cannot change an office's payment methods." });
    return null;
  }
  if (level === "owner" && scope.actorKind !== "provider") {
    res.status(403).json({ error: "Only the practice owner can choose the billing plan and accept the access terms." });
    return null;
  }
  return scope;
}

router.get("/billing/office/access", async (req, res) => {
  try {
    const scope = await scoped(req, res, "read"); if (!scope) return;
    res.json(await snapshotFor(scope));
  } catch (error) { answerError(req, res, error); }
});

/**
 * A SetupIntent the browser confirms with Stripe's payment element. The
 * element renders Stripe's own ACH authorization text for a bank account, so
 * no mandate wording is written here.
 */
router.post("/billing/office/access/setup-intent", async (req, res) => {
  try {
    const scope = await scoped(req, res, "staff"); if (!scope) return;
    const { slot } = z.object({ slot: Slot }).parse(req.body);
    const row = await ensureAccessSubscription(scope.providerId);
    const [customer, facts] = await Promise.all([ensureAccessCustomer(row), loadOfficeIdentity(scope.providerId)]);
    const stripe = await getStripe();
    const intent = await stripe.setupIntents.create({
      customer,
      usage: "off_session",
      payment_method_types: slot === "bank" ? ["us_bank_account"] : ["card"],
      metadata: { thinnr_provider_id: scope.providerId, thinnr_slot: slot, thinnr_purpose: "office_access" },
    });
    res.json({
      clientSecret: intent.client_secret,
      setupIntentId: intent.id,
      publishableKey: await getPublishableKey(),
      slot,
      // What the form's name and email start as; the office may edit both.
      billingDetails: defaultBillingDetails(facts),
    });
  } catch (error) { answerError(req, res, error); }
});

/**
 * There is deliberately no way to remove an instrument. An office always keeps
 * one bank account and two cards on file; a slot changes only by saving a
 * replacement into it (POST /instruments), which detaches the old method.
 */
router.delete(["/billing/office/access/instruments", "/billing/office/access/instruments/:slot"], (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    error: "Payment methods can be replaced but not removed. Your office always keeps a bank account and two cards on file.",
    code: "replace_only",
  });
});

/** Store an instrument the browser already collected — a first save or a replacement. */
router.post("/billing/office/access/instruments", async (req, res) => {
  try {
    const scope = await scoped(req, res, "staff"); if (!scope) return;
    const input = z.object({
      slot: Slot,
      paymentMethodId: z.string().min(1),
      setupIntentId: z.string().min(1).nullish(),
    }).parse(req.body);
    const context = connectContext(scope);
    await attachAccessInstrument({
      providerId: scope.providerId,
      slot: input.slot,
      paymentMethodId: input.paymentMethodId,
      setupIntentId: input.setupIntentId ?? null,
      actor: actorOf(scope, req),
    });
    res.json(await snapshotFor(scope, context));
  } catch (error) { answerError(req, res, error); }
});

router.post("/billing/office/access/plan", async (req, res) => {
  try {
    const scope = await scoped(req, res, "owner"); if (!scope) return;
    const { plan } = z.object({ plan: Plan }).parse(req.body);
    const context = connectContext(scope);
    const row = await selectAccessPlan({ providerId: scope.providerId, plan, actor: actorOf(scope, req) });
    res.json(await snapshotFor(scope, context, row));
  } catch (error) { answerError(req, res, error); }
});

router.post("/billing/office/access/disclosure", async (req, res) => {
  try {
    const scope = await scoped(req, res, "owner"); if (!scope) return;
    const { version } = z.object({ version: z.number().int().nonnegative() }).parse(req.body);
    const context = connectContext(scope);
    const row = await acknowledgeAccessDisclosure({ providerId: scope.providerId, version, actor: actorOf(scope, req) });
    res.json(await snapshotFor(scope, context, row));
  } catch (error) { answerError(req, res, error); }
});

/** Re-read the SetupIntent after the office entered its microdeposit amounts. */
router.post("/billing/office/access/bank/verify", async (req, res) => {
  try {
    const scope = await scoped(req, res, "staff"); if (!scope) return;
    const context = connectContext(scope);
    const result = await refreshBankVerification({ providerId: scope.providerId, actor: actorOf(scope, req) });
    res.json({ ...result, setup: await snapshotFor(scope, context) });
  } catch (error) { answerError(req, res, error); }
});

/** Settle an outstanding access balance now, through the normal waterfall. */
router.post("/billing/office/access/pay", async (req, res) => {
  try {
    const scope = await scoped(req, res, "staff"); if (!scope) return;
    const outcome = await chargeOfficeAccess(scope.providerId, { actor: actorOf(scope, req) });
    const setup = await snapshotFor(scope);
    if (!outcome || outcome.status === "skipped") {
      res.json({ status: outcome?.status === "skipped" ? outcome.reason : "nothing_due", setup });
      return;
    }
    res.json({ status: outcome.status, setup });
  } catch (error) { answerError(req, res, error); }
});

export default router;
