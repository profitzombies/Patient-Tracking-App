/**
 * HQ testing override — permanent delete of an office or a patient.
 *
 *  - GET  /hq/testing-delete/providers/:id   what would be erased (counts, Stripe)
 *  - POST /hq/testing-delete/providers/:id   { confirmName } → erase the office
 *  - GET  /hq/testing-delete/patients/:id    what would be erased
 *  - POST /hq/testing-delete/patients/:id    { confirmName } → erase the patient
 *
 * Temporary and NOT HIPAA compliant by design (see testing-delete/hard-delete.ts).
 * HQ admins with provider-management permission only; the POSTs also need a
 * fresh sign-in code and the exact name typed back. Deliberately writes no
 * audit row — the owner asked for no record of the deletion to remain.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { requireFreshCode } from "../auth/fresh-code";
import {
  HardDeleteError,
  hardDeletePatient,
  hardDeleteProvider,
  namesMatch,
  previewPatient,
  previewProvider,
} from "../testing-delete/hard-delete";

const router: IRouter = Router();

const ProviderId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const PatientId = z.string().uuid();
const Body = z.object({ confirmName: z.string().max(300) });

function fail(req: Request, res: Response, error: unknown): void {
  if (error instanceof HardDeleteError) {
    res.status(error.status).json({ error: error.message, ...(error.detail ?? {}) });
    return;
  }
  req.log?.error({ err: error }, "testing hard delete failed");
  res.status(500).json({ error: "The delete could not be completed. Try again." });
}

function parseId(res: Response, kind: "provider" | "patient", raw: unknown): string | null {
  const parsed = (kind === "provider" ? ProviderId : PatientId).safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: kind === "provider" ? "Unknown office." : "Unknown patient." });
    return null;
  }
  return parsed.data;
}

router.get("/hq/testing-delete/providers/:id", requireHqPermission("provider_manage"), async (req, res) => {
  const id = parseId(res, "provider", req.params.id);
  if (!id) return;
  try { res.json(await previewProvider(id)); } catch (error) { fail(req, res, error); }
});

router.get("/hq/testing-delete/patients/:id", requireHqPermission("provider_manage"), async (req, res) => {
  const id = parseId(res, "patient", req.params.id);
  if (!id) return;
  try { res.json(await previewPatient(id)); } catch (error) { fail(req, res, error); }
});

router.post("/hq/testing-delete/providers/:id", requireHqPermission("provider_manage"), async (req, res) => {
  const id = parseId(res, "provider", req.params.id);
  if (!id) return;
  const body = Body.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Type the office name to confirm." }); return; }
  if (!(await requireFreshCode(req, res, (res.locals.staff as StaffIdentity).userId))) return;
  try {
    const preview = await previewProvider(id);
    if (!namesMatch(body.data.confirmName, preview.name)) {
      res.status(400).json({ error: "The typed name does not match this office." });
      return;
    }
    res.json(await hardDeleteProvider(id));
  } catch (error) { fail(req, res, error); }
});

router.post("/hq/testing-delete/patients/:id", requireHqPermission("provider_manage"), async (req, res) => {
  const id = parseId(res, "patient", req.params.id);
  if (!id) return;
  const body = Body.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Type the patient's name to confirm." }); return; }
  if (!(await requireFreshCode(req, res, (res.locals.staff as StaffIdentity).userId))) return;
  try {
    const preview = await previewPatient(id);
    if (!namesMatch(body.data.confirmName, preview.name)) {
      res.status(400).json({ error: "The typed name does not match this patient." });
      return;
    }
    res.json(await hardDeletePatient(id));
  } catch (error) { fail(req, res, error); }
});

export default router;
