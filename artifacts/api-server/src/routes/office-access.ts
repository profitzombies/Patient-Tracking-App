/**
 * The office's own THINNR access: what it owes, and paying it.
 *
 *   GET  /office/access      state, price, dates, and the narrowed surface
 *   POST /office/access/pay  charge the office's stored instruments now
 *
 * Both stay reachable while the office is restricted for nonpayment — this is
 * the page the narrowed dashboard sends staff to, and the action that lifts
 * the restriction. Any staff member may pay (nonpayment is not an owner-only
 * problem), so this router resolves the office scope directly rather than
 * going through the owners-and-admins billing scope.
 *
 * Nothing here decides when a restriction starts or ends: the access-billing
 * engine owns that. This route reads its state and runs its charge.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { accessSummary } from "../billing/office-access/admin";
import { chargeOfficeAccess } from "../billing/office-access/charge";
import { loadAccessBillingSettings, revenueSharePercent } from "../billing/office-access/settings";
import {
  OFFICE_RESTRICTED_CAPABILITIES,
  OFFICE_RESTRICTED_STAFF_MESSAGE,
  officeRestrictedForNonpayment as restrictedNow,
} from "../lib/office-restriction";

const router: IRouter = Router();
const SERVER_ERROR = "Account status is unavailable right now.";

async function scoped(req: Request, res: Response) {
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: "financial_read",
    requireUnlocked: false,
  });
  if (resolved.kind !== "ok") {
    respondOfficeScopeDenied(req, res, resolved);
    return null;
  }
  return resolved.scope;
}

async function dto(providerId: string, restricted: boolean) {
  const [summary, settings] = await Promise.all([accessSummary(providerId), loadAccessBillingSettings()]);
  return {
    restricted,
    message: restricted ? OFFICE_RESTRICTED_STAFF_MESSAGE : null,
    allowed_capabilities: restricted ? [...OFFICE_RESTRICTED_CAPABILITIES] : null,
    share_percent: revenueSharePercent(settings, restricted),
    state: summary?.state ?? null,
    plan: summary?.plan ?? null,
    price_cents: summary?.priceCents ?? null,
    lifetime: summary?.lifetime ?? false,
    included_period_ends_at: summary?.includedPeriodEndsAt ?? null,
    paid_through: summary?.paidThrough ?? null,
    grace_ends_at: summary?.graceEndsAt ?? null,
    restricted_at: summary?.restrictedAt ?? null,
    setup_completed_at: summary?.setupCompletedAt ?? null,
  };
}

router.get("/office/access", async (req, res) => {
  try {
    const scope = await scoped(req, res);
    if (!scope) return;
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await dto(scope.providerId, scope.restricted));
  } catch (error) {
    req.log?.error({ err: error }, "office access read failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post("/office/access/pay", async (req, res) => {
  try {
    const scope = await scoped(req, res);
    if (!scope) return;
    if (scope.actorKind === "hq") {
      res.status(403).json({ error: "HQ cannot pay on an office's behalf from here." });
      return;
    }
    const outcome = await chargeOfficeAccess(scope.providerId, {
      actor: { kind: scope.actorKind === "provider" ? "provider" : "team_member", userId: scope.actorUserId },
    });
    if (!outcome) {
      res.status(409).json({ error: "This office has no THINNR access subscription to pay." });
      return;
    }
    if (outcome.status === "failed") {
      res.status(402).json({
        error: "That payment did not go through. Update the card on file and try again.",
        ...(await dto(scope.providerId, true)),
      });
      return;
    }
    // Paid (or nothing was due): the restriction is derived from the dates the
    // charge just moved, so the very next request sees full access again. An
    // ACH debit Stripe has only accepted is reported as pending — its webhook
    // decides whether it settles.
    res.json({
      paid: outcome.status === "succeeded",
      pending: outcome.status === "processing",
      ...(await dto(scope.providerId, outcome.status === "processing" ? await restrictedNow(scope.providerId) : false)),
    });
  } catch (error) {
    req.log?.error({ err: error }, "office access payment failed");
    res.status(502).json({ error: "That payment could not be started. Try again." });
  }
});

export default router;
