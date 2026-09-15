import { evaluateAttention, type AttentionReason } from "./attention";
import { activityFromSummaryRow } from "./patient-activity";
import { supabaseAdmin } from "./supabase-admin";
import { loadOfficeMedicationState } from "../medications/store";

type Row = Record<string, unknown>;
const enc = encodeURIComponent;

export interface OfficeAttentionItem {
  patientId: string;
  name: string;
  reasons: AttentionReason[];
  signature: string;
}

function date(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

export async function loadOfficeAttention(providerId: string, now: Date): Promise<{ asOf: string; items: OfficeAttentionItem[] }> {
  const asOf = now.toISOString().slice(0, 10);
  const [patientsRes, activityRes, statesRes, medication] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/patients?provider_id=eq.${enc(providerId)}&select=id,name,first_name,last_name,activation_status,created_at,program_start_date,deletion_requested_at&limit=500`),
    supabaseAdmin("POST", "/rest/v1/rpc/provider_patient_activity_summary", { p_provider_id: providerId, p_at: now.toISOString() }),
    supabaseAdmin("GET", `/rest/v1/patient_outreach_state?provider_id=eq.${enc(providerId)}&select=patient_id,stall,crossed_on_key,as_of_date&limit=500`),
    loadOfficeMedicationState(providerId, new Date(now.getTime() - 32 * 86_400_000).toISOString().slice(0, 10)),
  ]);
  for (const [label, result] of [["patients", patientsRes], ["activity", activityRes], ["outreach", statesRes]] as const) {
    if (result.status >= 300) throw new Error(`office attention ${label} load failed (${result.status})`);
  }
  const facts = new Map((Array.isArray(activityRes.json) ? activityRes.json as Row[] : []).map((row) => [String(row.patient_id), row]));
  const states = new Map((Array.isArray(statesRes.json) ? statesRes.json as Row[] : []).map((row) => [String(row.patient_id), row]));
  const items: OfficeAttentionItem[] = [];
  for (const patient of (Array.isArray(patientsRes.json) ? patientsRes.json as Row[] : [])) {
    const patientId = String(patient.id);
    const fact = facts.get(patientId);
    const activity = activityFromSummaryRow(fact, asOf);
    const localAsOf = activity?.asOfDate ?? asOf;
    const meds = medication.get(patientId);
    const state = states.get(patientId);
    const result = evaluateAttention({
      asOfDate: localAsOf,
      activationStatus: typeof patient.activation_status === "string" ? patient.activation_status : null,
      pendingDeletion: patient.deletion_requested_at != null,
      activityKnown: activity !== null,
      accountCreatedDate: date(patient.created_at),
      programStartDate: date(patient.program_start_date),
      latestWeightDate: date(fact?.latest_weight_date),
      latestDiaryDate: date(fact?.latest_diary_date),
      latestWaterDate: date(fact?.latest_water_date),
      latestCheckInDate: date(fact?.latest_check_in_date),
      latestActivityDate: date(fact?.latest_activity_date),
      activeMedicationStartDates: (meds?.medications ?? []).filter((m) => m.startDate <= localAsOf && (!m.stopDate || m.stopDate >= localAsOf)).map((m) => m.startDate),
      latestMedicationDoseDate: (meds?.doseLogs ?? []).map((log) => log.dueDate).sort().pop() ?? null,
      stall: state?.stall && typeof state.stall === "object" ? state.stall as { stalled?: boolean } : null,
      stallCrossedOnDate: date(state?.crossed_on_key),
      stallAsOfDate: date(state?.as_of_date),
    });
    if (!result.flagged || !result.signature) continue;
    const storedName = typeof patient.name === "string" ? patient.name.trim() : "";
    const splitName = [patient.first_name, patient.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ");
    items.push({ patientId, name: storedName || splitName || "Patient", reasons: result.reasons, signature: result.signature });
  }
  return { asOf, items };
}