/**
 * Server-side enforcement of app access on premium routes (coach chat and
 * stream, photo/menu/label reads, recipe images, barcode lookup) for
 * SIGNED-IN patients.
 *
 * The gate answers one distinct, non-retryable payload so a client that
 * ignores its own lock screen still cannot spend model budget:
 *   402 { error, retryable: false, upgradeRequired: true, entitlement }
 * Demo / unauthenticated turns never reach it (callers only ask for a
 * resolved patient id) and HQ's coach-paused rule is checked by the caller
 * BEFORE this gate, so a paused coach keeps its own 503 and wins.
 *
 * Infrastructure failures (billing tables unreadable, mode unconfigured) do
 * NOT lock the patient: a payments outage must not take the coach away from
 * people who are inside their free window or already paying. The failure is
 * logged loudly instead.
 */
import type { Request, Response } from "express";
import type { AppAccessEntitlement } from "./entitlement";
import { patientAppAccess } from "./service";

export const UPGRADE_REQUIRED_MESSAGE =
  "Your free access to the AI coach has ended. Upgrade in the app to keep using the coach, photo reads and barcode lookup.";

export interface UpgradeRequiredPayload {
  error: string;
  retryable: false;
  upgradeRequired: true;
  entitlement: AppAccessEntitlement;
}

export function upgradeRequiredPayload(entitlement: AppAccessEntitlement): UpgradeRequiredPayload {
  return { error: UPGRADE_REQUIRED_MESSAGE, retryable: false, upgradeRequired: true, entitlement };
}

/**
 * Evaluate the signed-in patient. Returns the entitlement when it could be
 * computed, null when the patient row is gone or the read failed (fail open,
 * logged). Pure read: no side effects, safe to call before any paid work.
 */
export async function appAccessFor(req: Request, patientId: string): Promise<AppAccessEntitlement | null> {
  try {
    const result = await patientAppAccess(patientId);
    return result?.entitlement ?? null;
  } catch (error) {
    req.log?.error({ err: error, patientId }, "app access entitlement unavailable; premium route left open");
    return null;
  }
}

/**
 * Send the upgrade payload and return false when the patient is locked;
 * true when the request may proceed. Callers run this after the coach-paused
 * check and before acquiring any model budget.
 */
export async function requireAppAccess(req: Request, res: Response, patientId: string): Promise<boolean> {
  const entitlement = await appAccessFor(req, patientId);
  if (!entitlement || entitlement.available) return true;
  res.status(402).json(upgradeRequiredPayload(entitlement));
  return false;
}
