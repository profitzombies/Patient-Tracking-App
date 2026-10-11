/**
 * Public delete-account request (app.trythinnr.com/delete-account), the URL
 * Google Play requires for account deletion outside the app.
 *
 *  - POST /account-deletion/start   { identifier }        → neutral "if an account matches, a code is on its way"
 *  - POST /account-deletion/verify  { requestId, code }   → files the same 7-day deletion request the
 *                                                           in-app "Close my account" button files
 *
 * The code rides the shared verification ledger under its own purpose
 * (`account_deletion`), so sign-in and recovery codes cannot delete an account
 * and a deletion code cannot sign anyone in. That holds for texted codes too:
 * live SMS for this purpose rides a DEDICATED Twilio Verify service
 * (TWILIO_ACCOUNT_DELETION_VERIFY_SERVICE_SID), because Twilio keeps one
 * pending code per number per service — a sign-in code texted at the same
 * moment lives on the other service and is never approved here. Without that
 * service configured, phone identities answer 503 (fail closed) rather than
 * share the sign-in service. Start reuses the identity-neutral
 * patient code rail (shared send pot, per-identity daily budget, timing
 * floors); verify reuses the one-shot code check. A request already pending
 * is reported with its grace end instead of being filed twice, and a filed
 * request is audited exactly like the in-app one.
 */
import { Router, type IRouter, type Request } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";
import { DeliveryNotConfiguredError } from "../claim/delivery";
import { clientIp } from "../auth/ledger";
import { loadPatientById } from "../auth/directory";
import { acquireCheckSlot, acquireSendSlot } from "../auth/limits";
import { checkCode, eligibleLinkedPatient, patientCodeStart } from "./auth";
import { deletionDto, loadPendingDeletion } from "./patient-privacy";
import { deletionGraceSeconds, type DeletionRequestRow } from "../privacy/purge";

const router: IRouter = Router();

export const ACCOUNT_DELETION_START_PATH = "/account-deletion/start";
export const ACCOUNT_DELETION_VERIFY_PATH = "/account-deletion/verify";

const CODE_ERROR = "That code didn't match or has expired. Check it and try again.";
const SERVER_ERROR = "We couldn't process that just now. Please try again in a moment.";

router.post(ACCOUNT_DELETION_START_PATH, async (req, res) => {
  const slot = acquireSendSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    await patientCodeStart(req, res, "account_deletion");
  } catch (error) {
    if (error instanceof DeliveryNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    req.log?.error({ err: error }, "public account deletion start failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(ACCOUNT_DELETION_VERIFY_PATH, async (req, res) => {
  const slot = acquireCheckSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const body = req.body ?? {};
    const row = await checkCode("account_deletion", body.requestId, body.code);
    const patient = row?.candidates?.length === 1 ? await loadPatientById(row.candidates[0].ref) : null;
    if (!row || !patient || !eligibleLinkedPatient(patient)) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    const existing = await loadPendingDeletion(patient.id);
    if (existing) {
      // Already scheduled (from the app or an earlier visit here): report the
      // grace end, file nothing, write no second audit line.
      res.status(200).json({ ok: true, alreadyPending: true, deletion: deletionDto(existing) });
      return;
    }
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_deletion_request", {
      p_patient_id: patient.id,
      p_grace_seconds: deletionGraceSeconds(),
    });
    if (result.status >= 300 || !Array.isArray(result.json) || result.json.length !== 1) {
      throw new Error(`deletion request failed (${result.status})`);
    }
    const filed = result.json[0] as DeletionRequestRow;
    audit(req, {
      action: "patient_deletion_requested",
      actorUserId: patient.auth_user_id ?? null,
      providerId: filed.provider_id,
      targetKind: "patient",
      targetId: patient.id,
      metadata: { requestId: filed.id, purgeAfter: filed.purge_after, channel: "web_delete_account" },
    });
    res.status(202).json({ ok: true, alreadyPending: false, deletion: deletionDto(filed) });
  } catch (error) {
    req.log?.error({ err: error }, "public account deletion verify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

function audit(req: Request, input: Omit<Parameters<typeof recordAdminAuditEvent>[0], "requestId" | "actorKind">): void {
  recordAdminAuditEvent({ ...input, actorKind: "patient", requestId: requestIdOf(req) }).catch((error) =>
    req.log?.error({ err: error, action: input.action }, "public account deletion audit failed"),
  );
}

export default router;
