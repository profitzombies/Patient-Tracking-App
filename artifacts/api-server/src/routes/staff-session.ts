/**
 * GET /staff-session — the operations web app's staff bootstrap: which kind
 * of staff account the bearer belongs to, the idle timeout that applies to
 * it, and whether the session's last code proof is still fresh enough for
 * the sensitive-action gate.
 *
 *   HQ members        → the HQ idle timeout
 *   office owners and teammates → the staff idle timeout, shortened by the
 *                       office override when one is set (never lengthened)
 *
 * 401 for no/expired session, 403 for a live session with no staff account
 * behind it (patients bootstrap elsewhere). Never cached.
 */
import { Router, type IRouter } from "express";
import { FRESH_CODE_WINDOW_MINUTES, freshCodeState } from "../auth/fresh-code";
import { identifyRequest } from "../auth/identify";
import { effectiveIdleTimeoutMinutes, loadOfficeOverrides, loadOrgPolicy } from "../lib/org-policy";
import { describeAccount } from "../security/actor";

const router: IRouter = Router();

export const STAFF_SESSION_PATH = "/staff-session";

router.get(STAFF_SESSION_PATH, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  try {
    const user = await identifyRequest(req);
    if (!user) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    const actor = await describeAccount(user.id);
    if (!actor || actor.realm !== "staff") {
      res.status(403).json({ error: "This account is not a staff account." });
      return;
    }
    const policy = await loadOrgPolicy();
    const idle =
      actor.staffKind === "hq"
        ? { minutes: policy.hqIdleTimeoutMinutes, source: "hq" as const }
        : effectiveIdleTimeoutMinutes(policy, actor.providerId ? await loadOfficeOverrides(actor.providerId) : null);
    const fresh = await freshCodeState(actor.userId, user.sessionId);
    res.json({
      staffKind: actor.staffKind,
      providerId: actor.providerId,
      idleTimeoutMinutes: idle.minutes,
      idleTimeoutSource: idle.source,
      freshCode: { codeVerifiedAt: fresh.codeVerifiedAt, fresh: fresh.fresh, windowMinutes: FRESH_CODE_WINDOW_MINUTES },
    });
  } catch (error) {
    req.log?.error({ err: error }, "staff session bootstrap failed");
    res.status(503).json({ error: "Could not load your session settings right now." });
  }
});

export default router;
