import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  ACCOUNT_COMPONENTS, BillingAccountError, buildOauthStartUrl, completeOauth, createAccountSession,
  createInAppAccount, syncAccount, toConnectedAccount,
} from "../billing/accounts";
import { publicOrigin } from "../billing/app-origin";
import { requireOfficeBillingScope, viewerOfficeRole } from "../billing/auth";
import { BillingLinkError, createLink, deactivateLink, listLinks, searchPatients } from "../billing/links";
import { BillingPriceError, listOfficePrices, setOfficePrice } from "../billing/prices";
import { getConnectClientId, isSandbox, stripeRejection } from "../billing/stripe-client";
import { selectMany, selectOne } from "../billing/store";
import { recordAdminAuditEvent, requestIdOf, type AuditMetadata } from "../lib/admin-audit";
import type { BillingOfficeScope } from "../billing/auth";

const router: IRouter = Router();
function audit(req: Request, scope: BillingOfficeScope, action: string, targetKind: string, targetId: string | null, metadata: AuditMetadata) {
  return recordAdminAuditEvent({
    action, actorUserId: scope.actorUserId, actorKind: scope.isHq ? "hq" : "team_member",
    providerId: scope.providerId, targetKind, targetId, requestId: requestIdOf(req), metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}
function answerError(req: Request, res: Response, error: unknown): void {
  req.log?.error({ err: error }, "billing office request failed");
  if (error instanceof BillingAccountError || error instanceof BillingPriceError || error instanceof BillingLinkError) {
    const field = "field" in error ? error.field : undefined;
    res.status(error.status).json({ error: error.message, ...(field ? { field } : {}),
      ...(error instanceof BillingAccountError && error.unsupported ? { unsupported: error.unsupported } : {}) });
    return;
  }
  const rejected = stripeRejection(error);
  if (rejected) { res.status(rejected.status).json({ error: rejected.message }); return; }
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
async function scoped(req: Request, res: Response, write: boolean) {
  return requireOfficeBillingScope(req, res, { write });
}
router.get("/billing/office/status", async (req, res) => {
  try {
    const scope = await scoped(req, res, false); if (!scope) return;
    let account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (account && (!account.last_synced_at || Date.now() - Date.parse(account.last_synced_at) > 10 * 60_000)) {
      try { await syncAccount(scope.providerId); account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(scope.providerId)}`); }
      catch { /* Stale status is safer than hiding the office's account during a Stripe outage. */ }
    }
    const [prices, links, sandbox] = await Promise.all([
      selectMany("billing_office_prices", `provider_id=eq.${encodeURIComponent(scope.providerId)}&select=product_id`),
      selectMany("billing_payment_links", `provider_id=eq.${encodeURIComponent(scope.providerId)}&active=eq.true&select=id`),
      isSandbox(),
    ]);
    res.json({
      account: account ? toConnectedAccount(account) : null, offered_products: prices.length, links: links.length,
      sandbox, oauth_available: Boolean(getConnectClientId()), viewer: viewerOfficeRole(scope),
      office: { provider_id: scope.providerId, office_name: scope.officeName },
    });
  } catch (error) { answerError(req, res, error); }
});
router.post("/billing/office/connect/create", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return;
    const account = await createInAppAccount(scope.providerId, scope.actorUserId);
    await audit(req, scope, "billing_connect_started", "billing_connected_account", account.stripe_account_id, { method: "express" });
    res.status(201).json({ account });
  } catch (error) { answerError(req, res, error); }
});
router.get("/billing/office/connect/oauth/start", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return;
    const url = await buildOauthStartUrl(scope.providerId, scope.actorUserId);
    await audit(req, scope, "billing_connect_started", "billing_connected_account", null, { method: "oauth" });
    res.json({ url });
  } catch (error) { answerError(req, res, error); }
});
router.get("/billing/oauth/callback", async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) throw new BillingAccountError("Stripe did not return a valid authorization.", 400);
    await completeOauth(code, state);
    res.redirect(302, `${publicOrigin()}/payments/get-paid?connected=1`);
  } catch (error) {
    req.log?.error({ err: error }, "billing oauth callback failed");
    const message = error instanceof Error ? error.message : "Stripe connection failed.";
    res.redirect(302, `${publicOrigin()}/payments/get-paid?error=${encodeURIComponent(message)}`);
  }
});
const SessionSchema = z.object({ components: z.array(z.string()).min(1) });
router.post("/billing/office/connect/account-session", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return;
    const parsed = SessionSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Choose at least one supported Stripe tool.", field: "components" }); return; }
    const unsupported = parsed.data.components.filter((component) => !ACCOUNT_COMPONENTS.includes(component as typeof ACCOUNT_COMPONENTS[number]));
    if (unsupported.length) {
      res.status(409).json({ error: "These tools are not available for this Stripe account.", unsupported });
      return;
    }
    res.json(await createAccountSession(scope.providerId, parsed.data.components as Array<typeof ACCOUNT_COMPONENTS[number]>));
  } catch (error) { answerError(req, res, error); }
});
router.post("/billing/office/connect/sync", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return;
    const account = await syncAccount(scope.providerId);
    await audit(req, scope, "billing_connect_completed", "billing_connected_account", account.stripe_account_id, {});
    res.json({ account });
  } catch (error) { answerError(req, res, error); }
});
router.get("/billing/office/prices", async (req, res) => {
  try { const scope = await scoped(req, res, false); if (!scope) return; res.json(await listOfficePrices(scope.providerId)); }
  catch (error) { answerError(req, res, error); }
});
const PriceSchema = z.object({ sell_price_cents: z.number().int().nonnegative().nullable(), subscription_enabled: z.boolean() });
router.put("/billing/office/prices/:product_id", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return;
    const parsed = PriceSchema.safeParse(req.body);
    if (!parsed.success) { const issue = parsed.error.issues[0]; res.status(400).json({ error: issue.message, field: String(issue.path[0] ?? "") }); return; }
    const prices = await setOfficePrice(scope.providerId, String(req.params.product_id), parsed.data, scope.actorUserId);
    await audit(req, scope, "billing_prices_updated", "billing_product", String(req.params.product_id), {
      product_id: String(req.params.product_id), products_changed: 1,
    });
    res.json(prices);
  } catch (error) { answerError(req, res, error); }
});
router.get("/billing/office/links", async (req, res) => {
  try { const scope = await scoped(req, res, false); if (!scope) return; res.json({ items: await listLinks(scope.providerId), next_cursor: null }); }
  catch (error) { answerError(req, res, error); }
});
const LinkSchema = z.object({ patient_id: z.string().uuid().nullish(), label: z.string().trim().max(120).nullish() });
router.post("/billing/office/links", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return; const parsed = LinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the link details." }); return; }
    const link = await createLink(scope.providerId, scope.actorUserId, parsed.data);
    await audit(req, scope, "billing_payment_link_created", "billing_payment_link", link.id, { link_id: link.id, active: true });
    res.status(201).json({ link });
  } catch (error) { answerError(req, res, error); }
});
router.delete("/billing/office/links/:id", async (req, res) => {
  try { const scope = await scoped(req, res, true); if (!scope) return;
    await deactivateLink(scope.providerId, String(req.params.id));
    await audit(req, scope, "billing_payment_link_updated", "billing_payment_link", String(req.params.id), {
      link_id: String(req.params.id), active: false,
    });
    res.status(204).end();
  } catch (error) { answerError(req, res, error); }
});
router.get("/billing/office/patients/search", async (req, res) => {
  try { const scope = await scoped(req, res, false); if (!scope) return;
    const q = typeof req.query.q === "string" ? req.query.q : ""; res.json(await searchPatients(scope.providerId, q));
  } catch (error) { answerError(req, res, error); }
});
export default router;