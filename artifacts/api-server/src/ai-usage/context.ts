/**
 * Request-scoped attribution for the AI usage ledger.
 *
 * Every HTTP request runs inside a usage context carrying its request id;
 * routes that spend model credits name their surface and, once identity is
 * resolved, the patient and office the spend belongs to. Pipelines that own
 * a sub-step (photo triage inside a chat turn) narrow the surface with
 * `withModelUsageSurface`. Anything that reaches the model with no surface
 * set lands in the ledger as `unattributed` — visible, never lost.
 */
import type { NextFunction, Request, Response } from "express";
import { runWithModelUsageContext, updateModelUsageContext } from "@workspace/integrations-openai-ai-server/usage";
import type { AiSurface } from "../ai/models";

export function modelUsageContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers["x-request-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const requestId = (typeof fromHeader === "string" && fromHeader) || (typeof req.id === "string" ? req.id : req.id !== undefined ? String(req.id) : null);
  runWithModelUsageContext({ surface: "unattributed", requestId }, () => next());
}

/** Names the surface (and, when known, the account/office) for the rest of this request. */
export function attributeModelUsage(input: {
  surface: AiSurface | (string & {});
  patientId?: string | null;
  providerId?: string | null;
  scope?: "patient" | "office" | "anonymous" | "system";
}): void {
  updateModelUsageContext(input);
}
