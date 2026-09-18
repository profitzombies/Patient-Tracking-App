import { Router, type IRouter, type Response } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { isCredentialLike } from "../coach/memory";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolvePatient } from "../lib/patient-auth";

const router: IRouter = Router();
const enc = encodeURIComponent;
const MAX_PAGE = 50;
const MAX_CORRECTION = 180;

function page(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : fallback;
  return Number.isInteger(n) ? Math.min(MAX_PAGE, Math.max(0, n)) : fallback;
}

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

function memoryDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    sensitivity: row.sensitivity,
    state: row.state,
    sourceConversationId: row.source_conversation_id,
    sourceMessageId: row.source_message_id,
    sourceCreatedAt: row.source_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    version: row.version,
  };
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const result = await supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
  return { status: result.status, json: result.json };
}

router.get("/patient-coach/memories", async (req, res) => {
  privateResponse(res);
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const limit = page(req.query.limit, 20) || 20;
    const offset = page(req.query.offset, 0);
    const result = await callRpc("coach_memory_list_patient", {
      p_patient_id: auth.patientId, p_limit: limit, p_offset: offset,
    });
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error("memory list unavailable");
    const rows = result.json as Record<string, unknown>[];
    const total = Number(rows[0]?.total ?? 0);
    const memories = rows.map(memoryDto);
    res.json({ memories, total, nextOffset: offset + memories.length < total ? offset + memories.length : null });
  } catch {
    res.status(502).json({ error: "Couldn't load what the coach remembers right now. Please try again." });
  }
});

router.patch("/patient-coach/memories/:memoryId", async (req, res) => {
  privateResponse(res);
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action;
    const expectedVersion = body.expectedVersion;
    const text = body.text;
    if (!["approve", "decline", "forget", "correct"].includes(String(action)) || !Number.isInteger(expectedVersion)) {
      res.status(400).json({ error: "Invalid memory update." }); return;
    }
    if (action === "correct" && (typeof text !== "string" || !text.trim() || text.length > MAX_CORRECTION || isCredentialLike(text))) {
      res.status(400).json({ error: "That correction can't be saved as a memory." }); return;
    }
    // Credentials remain categorically prohibited, including the otherwise
    // valid approve path for an old pending row.
    const result = await callRpc("coach_memory_mutate", {
      p_patient_id: auth.patientId, p_memory_id: req.params.memoryId, p_action: action,
      p_expected_version: expectedVersion, p_text: action === "correct" && typeof text === "string" ? text.trim() : null,
    });
    if (result.status === 409) { res.status(409).json({ error: "This memory changed. Refresh and try again." }); return; }
    if (result.status === 404) { res.status(404).json({ error: "Memory not found." }); return; }
    if (result.status >= 300 || !result.json || typeof result.json !== "object") throw new Error("memory update unavailable");
    res.json({ memory: memoryDto(result.json as Record<string, unknown>) });
  } catch {
    res.status(502).json({ error: "Couldn't update that memory right now. Please try again." });
  }
});

router.post("/patient-coach/conversations/:conversationId/retry-processing", async (req, res) => {
  privateResponse(res);
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const result = await callRpc("coach_memory_retry_processing", {
      p_patient_id: auth.patientId, p_conversation_id: req.params.conversationId,
    });
    if (result.status === 404) { res.status(404).json({ error: "Conversation not found." }); return; }
    if (result.status >= 300 || result.json !== true) throw new Error("retry refused");
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Couldn't retry processing right now. Please try again." });
  }
});

router.get("/office/patients/:patientId/coach-memories", async (req, res) => {
  privateResponse(res);
  try {
    const scope = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "conversation_clinical",
      requireUnlocked: true,
    });
    if (scope.kind !== "ok") { respondOfficeScopeDenied(req, res, scope); return; }
    const patient = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(req.params.patientId)}&provider_id=eq.${enc(scope.scope.providerId)}&archived_at=is.null&deletion_requested_at=is.null&select=id&limit=1`,
    );
    if (patient.status >= 300) throw new Error("patient lookup unavailable");
    if (!Array.isArray(patient.json) || !patient.json.length) { res.status(404).json({ error: "Patient record not found." }); return; }
    const limit = page(req.query.limit, 20) || 20;
    const offset = page(req.query.offset, 0);
    const result = await callRpc("coach_memory_list_provider", {
      p_patient_id: req.params.patientId, p_provider_id: scope.scope.providerId, p_limit: limit, p_offset: offset,
    });
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error("provider memory list unavailable");
    const rows = result.json as Record<string, unknown>[];
    const total = Number(rows[0]?.total ?? 0);
    const memories = rows.map(memoryDto);
    res.json({ memories, total, nextOffset: offset + memories.length < total ? offset + memories.length : null });
  } catch {
    res.status(502).json({ error: "Couldn't load coach memories right now. Please try again." });
  }
});

export default router;