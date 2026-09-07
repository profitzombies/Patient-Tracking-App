/**
 * Patient medication list and dose logging on the live data rail.
 *
 *   GET  /patient-data/medications        → { medications, doseLogs }
 *   PUT  /patient-data/medications        { medication } → upsert one record
 *   POST /patient-data/medication-doses   { id, medicationId, dueDate, dueTime,
 *                                           status: 'taken'|'skipped'|null, source }
 *
 * Same posture as the rest of patient-data: bearer session → patient row,
 * per-IP write limiter, optional idempotency key replay. A medication write
 * replaces the whole record (the phone owns the form), while a stop is just
 * a stop date — nothing is hard-deleted so past dose logs keep their
 * meaning. A dose log is one decision per scheduled occurrence: writing
 * `null` clears it; corrections are allowed for the trailing seven
 * patient-local days and never for future occurrences.
 */
import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { dayKeyInTimeZone } from "../lib/local-day";
import { resolvePatient } from "../lib/patient-auth";
import { createLimiter, envLimit } from "../coach/limits";
import { openIdempotentWrite } from "../lib/idempotency";
import { clientIp } from "../auth/ledger";
import {
  DOSE_CORRECTION_WINDOW_DAYS,
  isClockTime,
  isDateKey,
  isScheduledOn,
  normalizeTimes,
  shiftDateKey,
  validateMedicationInput,
  type DoseLogSource,
} from "../medications/schedule";
import {
  deleteDoseLog,
  getMedication,
  loadMedicationState,
  MedicationIdConflict,
  upsertDoseLog,
  upsertMedication,
} from "../medications/store";

const router: IRouter = Router();
const enc = encodeURIComponent;

const BUSY_MESSAGE = "The service is busy right now. Please try again in a moment.";
const WAIT_MESSAGE = "Please wait a moment before trying again.";
const DAILY_MESSAGE = "Daily limit reached. Please try again tomorrow.";

const acquireReadSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_READ_BURST", 60),
  refillPerMinute: 12,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_DATA_READ_DAILY_BUDGET", 5000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

const acquireWriteSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_WRITE_BURST", 40),
  refillPerMinute: 20,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_DATA_WRITE_DAILY_BUDGET", 8000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATIENT_DOSE_SOURCES = new Set<DoseLogSource>(["reminder", "check_in", "account"]);

export const DOSE_WINDOW_MESSAGE = `Doses can be logged or corrected for the past ${DOSE_CORRECTION_WINDOW_DAYS} days only.`;
export const DOSE_FUTURE_MESSAGE = "That dose isn't due yet.";
export const DOSE_NOT_SCHEDULED_MESSAGE = "That medication isn't scheduled at that time.";

async function patientTimeZone(patientId: string): Promise<string | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&select=timezone&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`patient timezone lookup failed (${res.status})`);
  const tz = (res.json[0] as { timezone?: unknown } | undefined)?.timezone;
  return typeof tz === "string" && tz ? tz : null;
}

router.get("/patient-data/medications", async (req, res) => {
  const slot = acquireReadSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const today = dayKeyInTimeZone(await patientTimeZone(auth.patientId));
    res.json(await loadMedicationState(auth.patientId, today));
  } catch (error) {
    req.log?.error({ err: error }, "patient-data medications fetch failed");
    res.status(502).json({ error: "Couldn't load your medications right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/medications", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const idem = await openIdempotentWrite(req, res, auth.patientId, "medications");
    if (idem.handled) return;
    const body = (req.body ?? {}) as { medication?: unknown };
    const parsed = validateMedicationInput(body.medication);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, field: parsed.field });
      return;
    }
    let medication;
    try {
      medication = await upsertMedication(auth.patientId, parsed.value, { source: "patient" });
    } catch (error) {
      if (error instanceof MedicationIdConflict) {
        res.status(400).json({ error: "Medication id is invalid.", field: "id" });
        return;
      }
      throw error;
    }
    await idem.finish(res, 200, { medication });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data medication write failed");
    res.status(502).json({ error: "Couldn't save that medication right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

interface DoseBody {
  id?: unknown;
  medicationId?: unknown;
  dueDate?: unknown;
  dueTime?: unknown;
  status?: unknown;
  source?: unknown;
  todayKey?: unknown;
}

router.post("/patient-data/medication-doses", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
    const idem = await openIdempotentWrite(req, res, auth.patientId, "medication-doses");
    if (idem.handled) return;
    const body = (req.body ?? {}) as DoseBody;
    if (typeof body.id !== "string" || !ID_RE.test(body.id)) {
      res.status(400).json({ error: "Dose log id is invalid.", field: "id" });
      return;
    }
    if (typeof body.medicationId !== "string" || !ID_RE.test(body.medicationId)) {
      res.status(400).json({ error: "Medication id is invalid.", field: "medicationId" });
      return;
    }
    if (!isDateKey(body.dueDate)) {
      res.status(400).json({ error: "Due date is invalid.", field: "dueDate" });
      return;
    }
    if (!isClockTime(body.dueTime)) {
      res.status(400).json({ error: "Due time is invalid.", field: "dueTime" });
      return;
    }
    if (body.status !== "taken" && body.status !== "skipped" && body.status !== null) {
      res.status(400).json({ error: "Status must be taken, skipped, or null.", field: "status" });
      return;
    }
    const source: DoseLogSource = PATIENT_DOSE_SOURCES.has(body.source as DoseLogSource) ? (body.source as DoseLogSource) : "account";

    const medication = await getMedication(auth.patientId, body.medicationId);
    if (!medication) {
      res.status(404).json({ error: "That medication isn't on your list." });
      return;
    }
    if (!isScheduledOn(medication, body.dueDate) || !normalizeTimes(medication.times).includes(body.dueTime)) {
      res.status(400).json({ error: DOSE_NOT_SCHEDULED_MESSAGE, field: "dueTime" });
      return;
    }
    // Window: the trailing seven patient-local days, allowing one day of
    // clock skew ahead (a device that already rolled past midnight).
    const today = dayKeyInTimeZone(await patientTimeZone(auth.patientId));
    const latest = shiftDateKey(today, 1);
    const earliest = shiftDateKey(today, -DOSE_CORRECTION_WINDOW_DAYS);
    if (body.dueDate > latest) {
      res.status(400).json({ error: DOSE_FUTURE_MESSAGE, field: "dueDate" });
      return;
    }
    if (body.dueDate < earliest) {
      res.status(400).json({ error: DOSE_WINDOW_MESSAGE, field: "dueDate" });
      return;
    }
    if (body.status === null) {
      await deleteDoseLog(auth.patientId, body.medicationId, body.dueDate, body.dueTime);
      await idem.finish(res, 200, { deleted: true });
      return;
    }
    const log = await upsertDoseLog(auth.patientId, {
      id: body.id,
      medicationId: body.medicationId,
      dueDate: body.dueDate,
      dueTime: body.dueTime,
      status: body.status,
      source,
    });
    await idem.finish(res, 200, { log });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data dose log write failed");
    res.status(502).json({ error: "Couldn't save that dose right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
