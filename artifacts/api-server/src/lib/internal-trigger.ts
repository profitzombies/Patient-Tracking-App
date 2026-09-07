/**
 * Shared bearer check for internal scheduler triggers (`/internal/...`).
 * One token — NOTIFICATIONS_INTERNAL_TOKEN — drives both the notification
 * tick and the clean-up job tick so a scheduled deployment needs a single
 * secret. Unset token → 404 (the route is invisible, not merely locked);
 * comparisons are constant-time.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

export const INTERNAL_TRIGGER_TOKEN_ENV = "NOTIFICATIONS_INTERNAL_TOKEN";

/** Writes the refusal and returns false when the request may not proceed. */
export function authorizeInternalTrigger(req: Request, res: Response): boolean {
  const configured = process.env[INTERNAL_TRIGGER_TOKEN_ENV];
  if (!configured || configured.trim() === "") {
    res.status(404).json({ error: "Not found." });
    return false;
  }
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(configured.trim());
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Unauthorized." });
    return false;
  }
  return true;
}
