/**
 * Provider-portal live endpoints: an office's live patient roster and
 * patient invitations (create + resend).
 *
 * Scope is never client-chosen for office staff — the bearer token resolves
 * to their own office (auth/office-scope). HQ callers name an office
 * explicitly and need the matching provider permission. Duplicate email and
 * phone conflicts answer with the same neutral wording no matter which
 * office owns the existing row.
 *
 * The invitation email goes out only AFTER the patient row has landed. Its
 * delivery state is durable (patients.invite_email_status) so a failed send
 * surfaces a Resend action instead of silently losing the invite, and the
 * resend rides an atomic conditional UPDATE on invite_email_updated_at — the
 * rate limit and the double-send guard are the same database write.
 *
 * Claiming needs no code here: an invited row's phone is found by the
 * existing passwordless login rail, which links the auth user, preserves
 * provider_id, and flips activation_status to activated (auth/session.ts).
 */
import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveOfficeScope, type OfficeScope } from "../auth/office-scope";
import { acquireInviteSlot } from "../auth/limits";
import { clientIp } from "../auth/ledger";
import { lookupPatients } from "../auth/directory";
import {
  DeliveryNotConfiguredError,
  sendPatientInvitation,
} from "../claim/delivery";
import { effectiveProviderCode, normalizeUsPhone } from "./provider-accounts";
import { objectStorage } from "../lib/objectStorage";
import { isOwnPatientMediaPath } from "./patient-media";
import { programDayFor } from "../coach/real-patient";
import { dayKeyInTimeZone } from "../lib/local-day";

const router: IRouter = Router();

function enc(value: string): string {
  return encodeURIComponent(value);
}

const SERVER_ERROR = "Something went wrong on our side. Please try again.";
const EMAIL_TAKEN = "That email is already on a patient account. Use a different email.";
const PHONE_TAKEN = "That phone number is already on a patient account. Use a different number.";

function patientUniqueConflict(message: string): "email" | "phone" | null {
  if (/patients_email_(?:normalized_)?unique_idx/.test(message)) return "email";
  if (/patients_phone_(?:normalized_)?unique_idx/.test(message)) return "phone";
  return null;
}

/** Resend cooldown; env knob exists so tests can stage the limit deterministically. */
function resendCooldownSeconds(): number {
  // NB: Number("") is 0 — an unset/blank knob must fall through to the
  // 60s default, not disable the cooldown.
  const raw = process.env.PATIENT_INVITE_RESEND_SECONDS;
  if (raw == null || raw.trim() === "") return 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

const PATIENT_SELECT =
  "id,provider_id,first_name,last_name,name,email,phone,activation_status,auth_user_id,claimed_at,created_at,invited_at,invited_by,invite_email_status,invite_email_updated_at,program_id,program_start_date,date_of_birth,height,height_inches,starting_weight,current_weight,goal_weight,weight_gain_lost,timezone,profile_completed_at,last_login_at,last_log_date";

type PatientRosterRow = Record<string, unknown>;

export type InvitationEmailOutcome = "sent" | "failed" | "not_configured";

function patientDto(row: PatientRosterRow) {
  const invited = typeof row.invited_at === "string" && row.invited_at.length > 0;
  const verified = typeof row.auth_user_id === "string" && row.auth_user_id.length > 0;
  return {
    id: String(row.id),
    name: canonicalName(row),
    firstName: canonicalFirstName(row),
    lastName: canonicalLastName(row),
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    phoneDisplay: normalizeUsPhone(typeof row.phone === "string" ? row.phone : ""),
    activationStatus: row.activation_status ? String(row.activation_status) : null,
    verified,
    createdAt: row.created_at ? String(row.created_at) : null,
    program: {
      id: row.program_id ? String(row.program_id) : null,
      startDate: row.program_start_date ? String(row.program_start_date) : null,
      startingWeight: numericOrNull(row.starting_weight),
      currentWeight: numericOrNull(row.current_weight),
      goalWeight: numericOrNull(row.goal_weight),
      weightChange: numericOrNull(row.weight_gain_lost),
      lastLogDate: row.last_log_date ? String(row.last_log_date) : null,
      day: programDayFor(
        {
          name: canonicalName(row),
          program_start_date: row.program_start_date ? String(row.program_start_date) : null,
          created_at: row.created_at ? String(row.created_at) : null,
        },
        // The patient's own calendar day, not the server's UTC date — a
        // roster viewed in the evening must not show tomorrow's program day.
        dayKeyInTimeZone(typeof row.timezone === "string" ? row.timezone : null),
      ),
    },
    invitation: invited
      ? {
          state: verified ? ("verified" as const) : ("pending" as const),
          invitedAt: String(row.invited_at),
          emailStatus: row.invite_email_status
            ? (String(row.invite_email_status) as "pending" | "sent" | "failed")
            : "pending",
          emailUpdatedAt: row.invite_email_updated_at ? String(row.invite_email_updated_at) : null,
        }
      : null,
  };
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function canonicalFirstName(row: PatientRosterRow): string {
  const stored = typeof row.first_name === "string" ? row.first_name.trim() : "";
  return stored || String(row.name ?? "").trim().split(/\s+/)[0] || "";
}

function canonicalLastName(row: PatientRosterRow): string {
  const stored = typeof row.last_name === "string" ? row.last_name.trim() : "";
  return stored || String(row.name ?? "").trim().split(/\s+/).slice(1).join(" ");
}

function canonicalName(row: PatientRosterRow): string {
  return [canonicalFirstName(row), canonicalLastName(row)].filter(Boolean).join(" ");
}

function identityDto(row: PatientRosterRow) {
  return {
    id: String(row.id),
    name: canonicalName(row),
    firstName: canonicalFirstName(row),
    lastName: canonicalLastName(row),
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    phoneDisplay: normalizeUsPhone(typeof row.phone === "string" ? row.phone : ""),
    activationStatus: row.activation_status ? String(row.activation_status) : null,
    verified: typeof row.auth_user_id === "string" && row.auth_user_id.length > 0,
    dateOfBirth: row.date_of_birth ? String(row.date_of_birth) : null,
    height: row.height ? String(row.height) : null,
    heightInches: numericOrNull(row.height_inches),
    profileSetupComplete: typeof row.profile_completed_at === "string",
    timezone: row.timezone ? String(row.timezone) : null,
    createdAt: row.created_at ? String(row.created_at) : null,
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
  };
}

const RECORD_NOT_FOUND = "No patient record found for this office.";
const STAFF_PHOTO_TTL_SEC = 15 * 60;

async function authorizedPhotoUrl(patientId: string, path: unknown): Promise<string | null> {
  if (typeof path !== "string" || !isOwnPatientMediaPath(path, patientId)) return null;
  return objectStorage.signedDownloadURL(path, STAFF_PHOTO_TTL_SEC);
}

export type OfficePatientDto = ReturnType<typeof patientDto>;

/**
 * The app link for the invitation email. Deployments set PATIENT_APP_URL;
 * the workspace falls back to the Expo dev domain. No link means email
 * delivery is not configured — better an honest retry state than a dead
 * button in a patient's inbox.
 */
function patientAppLink(): string {
  const configured = process.env.PATIENT_APP_URL?.trim();
  if (configured) return configured;
  const expo = process.env.REPLIT_EXPO_DEV_DOMAIN?.trim();
  if (expo) return `https://${expo}`;
  // No app link = the invitation email cannot be composed; surface the same
  // durable "not configured" retry state as missing email credentials.
  throw new DeliveryNotConfiguredError("email");
}

/**
 * Send the branded email for an already-committed invitation row and record
 * the durable delivery state. Never throws — the row is the source of truth
 * and the caller reports the outcome.
 */
async function deliverInvitationEmail(input: {
  patientId: string;
  firstName: string;
  email: string;
  phoneDisplay: string;
  scope: OfficeScope;
  log?: { error: (obj: unknown, msg: string) => void };
}): Promise<InvitationEmailOutcome> {
  let outcome: InvitationEmailOutcome = "sent";
  try {
    await sendPatientInvitation(input.email, {
      name: input.firstName,
      providerName: input.scope.providerName,
      officeName: input.scope.officeName,
      providerCode:
        effectiveProviderCode(input.scope.onboardingCode, input.scope.providerId) ??
        input.scope.providerId,
      phone: input.phoneDisplay,
      appLink: patientAppLink(),
    });
  } catch (error) {
    outcome = error instanceof DeliveryNotConfiguredError ? "not_configured" : "failed";
    input.log?.error({ err: error }, "patient invitation email failed");
  }
  const patched = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patients?id=eq.${enc(input.patientId)}`,
    {
      invite_email_status: outcome === "sent" ? "sent" : "failed",
      invite_email_updated_at: new Date().toISOString(),
    },
  );
  if (patched.status >= 300) {
    input.log?.error(
      { status: patched.status },
      "patient invitation email status update failed",
    );
  }
  return outcome;
}

router.get("/office/roster", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;
    const rows = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?provider_id=eq.${enc(scope.providerId)}&select=${PATIENT_SELECT}&order=created_at.desc&limit=500`,
    );
    if (rows.status >= 300) throw new Error(`roster load failed (${rows.status})`);
    const patients = (Array.isArray(rows.json) ? (rows.json as PatientRosterRow[]) : []).map(
      patientDto,
    );
    res.json({
      office: {
        providerId: scope.providerId,
        officeName: scope.officeName,
        providerCode:
          effectiveProviderCode(scope.onboardingCode, scope.providerId) ?? scope.providerId,
      },
      patients,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office roster failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

/**
 * Complete, read-only patient record for provider/HQ drill-in screens.
 * The patient lookup is deliberately scoped in the same query: an unknown id
 * and another office's id produce the identical answer and no history queries.
 */
router.get("/office/patients/:id", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;
    const patientId = String(req.params.id ?? "");
    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}` +
        `&select=${PATIENT_SELECT}&limit=1`,
    );
    if (found.status >= 300) throw new Error(`patient record lookup failed (${found.status})`);
    const patient = Array.isArray(found.json)
      ? (found.json[0] as PatientRosterRow | undefined)
      : undefined;
    if (!patient) {
      res.status(404).json({ error: RECORD_NOT_FOUND });
      return;
    }

    const pid = enc(patientId);
    const [entries, water, targets, prefs, foods, recipes, photos, checkIns, flags] =
      await Promise.all([
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_diary_entries?patient_id=eq.${pid}` +
            "&select=entry_id,date_key,meal,kind,ref_id,name,detail,quantity,calories,protein,carbs,fat,adjustments" +
            "&order=date_key.asc,created_at.asc,entry_id.asc&limit=5000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_water_days?patient_id=eq.${pid}&select=date_key,oz&order=date_key.asc&limit=2000`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_target_overrides?patient_id=eq.${pid}&select=calories,protein,carbs,fat,water_oz&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_food_prefs?patient_id=eq.${pid}&select=favorites,recents&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_custom_foods?patient_id=eq.${pid}` +
            "&select=food_id,name,brand,serving,calories,protein,carbs,fat,photo_path&order=created_at.asc,food_id.asc&limit=1000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_saved_recipes?patient_id=eq.${pid}` +
            "&select=recipe_id,name,meal,mode,tags,minutes,servings,calories,protein,carbs,fat,description,ingredients,steps,grocery_list,saved_at,photo_path" +
            "&order=created_at.asc,recipe_id.asc&limit=1000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_progress_photos?patient_id=eq.${pid}` +
            "&select=photo_id,date_key,label,angle,object_path&order=created_at.asc,photo_id.asc&limit=1000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_check_ins?patient_id=eq.${pid}` +
            "&select=check_in_id,date_key,weight,mood,side_effects,notes&order=date_key.asc&limit=2000",
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_flags?patient_id=eq.${pid}` +
            "&select=nudge_opt_out,nudge_engaged,nudge_last_sent_key,nudge_last_crossing_key,onboarding_complete,onboarding_answers,notification_prefs&limit=1",
        ),
      ]);
    const results = [entries, water, targets, prefs, foods, recipes, photos, checkIns, flags];
    if (results.some((result) => result.status >= 300 || !Array.isArray(result.json))) {
      throw new Error("patient record history load failed");
    }

    const entryList = (entries.json as PatientRosterRow[]).map((row) => ({
      id: String(row.entry_id),
      dateKey: String(row.date_key),
      meal: row.meal,
      kind: row.kind,
      ...(row.ref_id ? { refId: String(row.ref_id) } : {}),
      name: row.name,
      detail: typeof row.detail === "string" ? row.detail : "",
      quantity: Number(row.quantity),
      calories: Number(row.calories),
      protein: Number(row.protein),
      carbs: Number(row.carbs),
      fat: Number(row.fat),
      ...(Array.isArray(row.adjustments) && row.adjustments.length
        ? { adjustments: row.adjustments }
        : {}),
    }));
    type Nutrition = { calories: number; protein: number; carbs: number; fat: number };
    const overall: Nutrition = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    const byDate: Record<string, Nutrition> = {};
    for (const entry of entryList) {
      const day = (byDate[entry.dateKey] ??= { calories: 0, protein: 0, carbs: 0, fat: 0 });
      for (const nutrient of ["calories", "protein", "carbs", "fat"] as const) {
        day[nutrient] += entry[nutrient];
        overall[nutrient] += entry[nutrient];
      }
    }

    const waterDays = (water.json as PatientRosterRow[]).map((row) => ({
      dateKey: String(row.date_key),
      oz: Number(row.oz),
    }));
    const checkInList = (checkIns.json as PatientRosterRow[]).map((row) => ({
      id: String(row.check_in_id),
      dateKey: String(row.date_key),
      weight: numericOrNull(row.weight),
      mood: numericOrNull(row.mood),
      sideEffects: Array.isArray(row.side_effects) ? row.side_effects : [],
      notes: typeof row.notes === "string" ? row.notes : null,
    }));
    const target = (targets.json as PatientRosterRow[])[0];
    const pref = (prefs.json as PatientRosterRow[])[0];
    const flag = (flags.json as PatientRosterRow[])[0];

    const photoList = await Promise.all(
      (photos.json as PatientRosterRow[]).map(async (row) => ({
        id: String(row.photo_id),
        dateKey: String(row.date_key),
        label: row.label ? String(row.label) : "",
        angle: row.angle ? String(row.angle) : null,
        url: await authorizedPhotoUrl(patientId, row.object_path),
      })),
    );
    const customFoods = await Promise.all(
      (foods.json as PatientRosterRow[]).map(async (row) => ({
        id: String(row.food_id),
        name: String(row.name ?? ""),
        brand: row.brand ? String(row.brand) : null,
        serving: String(row.serving ?? ""),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        photoUrl: await authorizedPhotoUrl(patientId, row.photo_path),
      })),
    );
    const savedRecipes = await Promise.all(
      (recipes.json as PatientRosterRow[]).map(async (row) => ({
        id: String(row.recipe_id),
        name: String(row.name ?? ""),
        meal: row.meal,
        mode: row.mode,
        tags: Array.isArray(row.tags) ? row.tags : [],
        minutes: Number(row.minutes),
        servings: Number(row.servings),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        description: typeof row.description === "string" ? row.description : "",
        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
        steps: Array.isArray(row.steps) ? row.steps : [],
        groceryList: Array.isArray(row.grocery_list) ? row.grocery_list : [],
        savedAt: row.saved_at ? String(row.saved_at) : null,
        photoUrl: await authorizedPhotoUrl(patientId, row.photo_path),
      })),
    );
    const customFoodById = new Map(customFoods.map((food) => [food.id, food]));
    const diaryFoodById = new Map<string, { id: string; name: string; detail: string }>();
    for (const entry of entryList) {
      if (!entry.refId || diaryFoodById.has(entry.refId)) continue;
      diaryFoodById.set(entry.refId, {
        id: entry.refId,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name : "Saved food",
        detail: entry.detail,
      });
    }
    const preferenceFoods = (value: unknown) =>
      (Array.isArray(value) ? value : [])
        .filter((id): id is string => typeof id === "string")
        .map((id) => customFoodById.get(id) ?? diaryFoodById.get(id) ?? {
          id,
          name: "Food details unavailable",
        });

    res.json({
      office: {
        providerId: scope.providerId,
        officeName: scope.officeName,
        providerCode:
          effectiveProviderCode(scope.onboardingCode, scope.providerId) ?? scope.providerId,
      },
      patient: {
        identity: identityDto(patient),
        program: patientDto(patient).program,
      },
      diary: {
        entries: entryList,
        nutritionTotals: {
          overall,
          byDate: Object.entries(byDate).map(([dateKey, totals]) => ({ dateKey, ...totals })),
        },
      },
      water: waterDays,
      checkIns: checkInList,
      weights: checkInList
        .filter((item) => item.weight !== null)
        .map((item) => ({ dateKey: item.dateKey, weight: item.weight })),
      progressPhotos: photoList,
      account: {
        targets: {
          calories: numericOrNull(target?.calories),
          protein: numericOrNull(target?.protein),
          carbs: numericOrNull(target?.carbs),
          fat: numericOrNull(target?.fat),
          waterOz: numericOrNull(target?.water_oz),
        },
        favorites: preferenceFoods(pref?.favorites),
        recents: preferenceFoods(pref?.recents),
        customFoods,
        savedRecipes,
        flags: {
          nudgeOptOut: flag?.nudge_opt_out === true,
          nudgeEngaged: flag?.nudge_engaged === true,
          nudgeLastSentKey: flag?.nudge_last_sent_key
            ? String(flag.nudge_last_sent_key)
            : null,
          nudgeLastCrossingKey: flag?.nudge_last_crossing_key
            ? String(flag.nudge_last_crossing_key)
            : null,
          onboardingComplete: flag?.onboarding_complete === true,
          onboardingAnswers:
            flag?.onboarding_answers && typeof flag.onboarding_answers === "object"
              ? flag.onboarding_answers
              : null,
          notificationPrefs:
            flag?.notification_prefs && typeof flag.notification_prefs === "object"
              ? flag.notification_prefs
              : null,
        },
      },
    });
  } catch (error) {
    req.log?.error({ err: error }, "office patient record failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

const InviteInput = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(80, "First name is too long."),
  lastName: z.string().trim().min(1, "Last name is required.").max(80, "Last name is too long."),
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .max(320, "Email is too long.")
    .email("Enter a valid email address."),
  phone: z.string().trim().min(1, "Phone number is required.").max(40, "Enter a valid 10-digit US mobile number."),
  office: z.string().trim().max(120).optional(),
});

router.post("/office/invitations", async (req, res) => {
  const slot = acquireInviteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const parsed = InviteInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: issue?.message ?? "Check the invitation form and try again.",
        field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined,
      });
      return;
    }
    const phoneDisplay = normalizeUsPhone(parsed.data.phone);
    if (!phoneDisplay) {
      res.status(400).json({
        error: "Enter a valid 10-digit US mobile number.",
        field: "phone",
      });
      return;
    }
    const phoneDigits = phoneDisplay.replace(/\D/g, "");
    const phoneE164 = `+1${phoneDigits}`;
    const email = parsed.data.email.toLowerCase();

    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: parsed.data.office ?? null,
      hqPermission: "provider_manage",
      requireUnlocked: true,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;

    // Pre-checks give clear field-level errors; the partial unique indexes
    // on the insert below are the airtight backstop. Both answers stay
    // neutral about who owns the existing row.
    const emailTaken = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?email=ilike.${enc(email)}&select=id&limit=1`,
    );
    if (emailTaken.status >= 300) throw new Error(`email check failed (${emailTaken.status})`);
    if (Array.isArray(emailTaken.json) && emailTaken.json.length > 0) {
      res.status(409).json({ error: EMAIL_TAKEN, field: "email" });
      return;
    }
    const phoneMatches = await lookupPatients({
      kind: "phone",
      e164: phoneE164,
      last10: phoneDigits,
    });
    if (phoneMatches.length > 0) {
      res.status(409).json({ error: PHONE_TAKEN, field: "phone" });
      return;
    }

    const now = new Date().toISOString();
    const patientId = crypto.randomUUID();
    const firstName = parsed.data.firstName.replace(/\s+/g, " ");
    const lastName = parsed.data.lastName.replace(/\s+/g, " ");
    const inserted = await supabaseAdmin(
      "POST",
      "/rest/v1/patients",
      {
        id: patientId,
        provider_id: scope.providerId,
        name: `${firstName} ${lastName}`,
        email,
        phone: phoneE164,
        activation_status: "invited",
        created_at: now,
        invited_at: now,
        invited_by: scope.actorUserId,
        invite_email_status: "pending",
        invite_email_updated_at: now,
      },
      "return=representation",
    );
    if (inserted.status >= 300) {
      const message = String((inserted.json as { message?: unknown })?.message ?? "");
      const conflict = patientUniqueConflict(message);
      if (conflict === "email") {
        res.status(409).json({ error: EMAIL_TAKEN, field: "email" });
        return;
      }
      if (conflict === "phone") {
        res.status(409).json({ error: PHONE_TAKEN, field: "phone" });
        return;
      }
      throw new Error(`patient invite insert failed (${inserted.status})`);
    }
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as
      | PatientRosterRow
      | undefined;
    if (!row) throw new Error("patient invite insert returned no row");

    // Email only after the row has landed — its outcome is durable state.
    const invitation = await deliverInvitationEmail({
      patientId,
      firstName,
      email,
      phoneDisplay,
      scope,
      log: req.log,
    });
    res.status(201).json({
      patient: patientDto({
        ...row,
        invite_email_status: invitation === "sent" ? "sent" : "failed",
      }),
      invitation,
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient invitation failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/office/invitations/:id/resend", async (req, res) => {
  const slot = acquireInviteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId:
        typeof (req.body ?? {}).office === "string"
          ? String((req.body as { office?: string }).office)
          : typeof req.query.office === "string"
            ? req.query.office
            : null,
      hqPermission: "provider_manage",
      requireUnlocked: true,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;
    const id = String(req.params.id ?? "");

    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(id)}&select=${PATIENT_SELECT}&limit=1`,
    );
    if (found.status >= 300) throw new Error(`invitation lookup failed (${found.status})`);
    const row = Array.isArray(found.json) ? (found.json[0] as PatientRosterRow | undefined) : undefined;
    // One neutral answer for "doesn't exist", "not this office's patient",
    // and "not an invited row" — cross-office probing learns nothing.
    if (!row || String(row.provider_id ?? "") !== scope.providerId || !row.invited_at) {
      res.status(404).json({ error: "No invitation found for this office." });
      return;
    }
    if (row.auth_user_id) {
      res.status(409).json({
        error: "This patient has already verified their account — no invitation needed.",
      });
      return;
    }

    // Atomic rate limit + double-send guard: the conditional UPDATE only
    // lands while the row is unclaimed and outside the cooldown window.
    const cooldown = resendCooldownSeconds();
    const cutoff = new Date(Date.now() - cooldown * 1000).toISOString();
    const guarded = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patients?id=eq.${enc(id)}&provider_id=eq.${enc(scope.providerId)}&auth_user_id=is.null&or=(invite_email_updated_at.is.null,invite_email_updated_at.lt.${enc(cutoff)})`,
      { invite_email_status: "pending", invite_email_updated_at: new Date().toISOString() },
      "return=representation",
    );
    if (guarded.status >= 300) throw new Error(`invitation resend guard failed (${guarded.status})`);
    if (!Array.isArray(guarded.json) || guarded.json.length !== 1) {
      res.status(429).json({
        error: "This invitation was just sent. Please wait a minute before resending.",
        retryable: true,
      });
      return;
    }

    const name = String(row.name ?? "");
    const firstName = name.split(/\s+/)[0] || name || "there";
    const email = String(row.email ?? "");
    const phoneDisplay =
      normalizeUsPhone(typeof row.phone === "string" ? row.phone : "") ??
      String(row.phone ?? "");
    const invitation = await deliverInvitationEmail({
      patientId: id,
      firstName,
      email,
      phoneDisplay,
      scope,
      log: req.log,
    });
    res.json({
      ok: true,
      invitation,
      patient: patientDto({
        ...row,
        invite_email_status: invitation === "sent" ? "sent" : "failed",
        invite_email_updated_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient invitation resend failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
