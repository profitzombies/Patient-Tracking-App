/**
 * Patient-data routes — the live per-patient diary rail.
 *
 * A signed-in patient's food diary entries, water, daily-target overrides,
 * and the recents/favorites lists live in service-role-only Supabase tables
 * (see supabase/migrations/20260912000000_patient_diary.sql). The mobile app
 * never touches those tables directly: every read and write comes through
 * here with the patient's bearer session token, which resolves to a
 * patients row exactly like the claim flow's whoami does.
 *
 * Contract with the app (context/PatientContext.tsx real-account mode):
 *  - GET  /patient-data/state       → the full server-backed slice for a
 *    date range: entries (client shape), water by date, target overrides,
 *    favorites, recents. The app hydrates from this on sign-in.
 *  - POST /patient-data/entries     → one gesture's entry writes, batched:
 *    upserts (add / copy / edit / restore-undo carry client-generated ids so
 *    optimistic rows and server rows are the same rows), deletes, and the
 *    recents bump that rides an add. Upserts merge on (patient_id, entry_id).
 *  - PUT  /patient-data/water       → one day's ounces.
 *  - PUT  /patient-data/targets     → partial daily-target override merge.
 *  - PUT  /patient-data/prefs       → favorites and/or recents lists.
 *  - POST /patient-data/library     → one gesture's foods-library writes,
 *    batched: custom-food / saved-recipe upserts (client-generated ids, full
 *    nutrition snapshots, optional patient-media photo paths), deletes, and
 *    the favorites/recents lists that ride a delete. The state read returns
 *    customFoods + savedRecipes alongside the diary slice, so one hydration
 *    fills the whole account-backed store.
 *  - POST /patient-data/check-ins   → one check-in (weight, mood, side
 *    effects, notes). One row per day: a same-day re-submit replaces the
 *    previous answers wholesale, mirroring the app's local behavior.
 *  - POST /patient-data/photos      → progress-photo GRID writes: upserts
 *    (rows pointing at objects the patient already uploaded on the
 *    patient-media rail, kind "progress") and deletes. A delete drops the
 *    grid row and media-ledger row in one transaction, then deletes the
 *    stored bytes — the app only calls it after its local undo window
 *    closes.
 *  - PUT  /patient-data/flags       → partial account-flag merge: the
 *    stall-nudge outreach state, onboarding answers/completion, and
 *    notification preferences.
 *
 * Failures are explicit: bad payloads 400, missing/expired sessions 401,
 * non-patient accounts 403, upstream trouble 502/503. The app rolls back its
 * optimistic write and shows the error — never a silent local-only save.
 */
import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { dayKeyInTimeZone, maxPlausibleDayKey } from "../lib/local-day";
import { mintPatientMediaToken } from "../lib/media-token";
import { resolvePatient } from "../lib/patient-auth";
import { createLimiter, envLimit } from "../coach/limits";
import { openIdempotentWrite } from "../lib/idempotency";
import { clientIp } from "../auth/ledger";
import { isOwnPatientMediaPath, PATIENT_MEDIA_PREFIX } from "./patient-media";
import { deletePhotoWithVariants } from "../lib/photo-variants";
import { firstNameOf, programDayFor } from "../coach/real-patient";
import crypto from "node:crypto";
import { normalizeIdentifier } from "../claim/normalize";
import { validateNotificationPrefsInput } from "../notifications/policy";
import { supabaseNotificationStore } from "../notifications/store";
import { OUTREACH_KIND } from "../notifications/stall-outreach";
import { loadPrivacyState } from "./patient-privacy";
import { recordPatientEvent } from "../lib/patient-events";
import { changedFields, recordPatientEditHistory } from "../lib/patient-edit-history";
import { seedMedicationsFromOnboarding } from "../medications/seed";
import { loadMedicationState } from "../medications/store";
import {
  assertLiveChannelReady,
  checkTwilioVerification,
  deliveryMode,
  DeliveryNotConfiguredError,
  generateCode,
  sendClaimEmail,
  startTwilioVerification,
} from "../claim/delivery";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  SENDS_PER_IDENTIFIER_PER_HOUR,
  codeMatches,
  isCodeShaped,
  isUuid,
  loadRowById,
  patchRow,
  sha256,
  takeAttempt,
} from "../auth/ledger";

const router: IRouter = Router();
const enc = encodeURIComponent;

async function reconcilePatientRewards(patientId: string, todayKey?: string): Promise<unknown> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_rewards_reconcile", {
    p_patient_id: patientId,
    ...(todayKey ? { p_today_key: todayKey } : {}),
  });
  if (result.status >= 300) throw new Error(`patient rewards reconcile failed (${result.status})`);
  return result.json;
}

// ── Per-IP limits (demo posture: open route, bounded abuse) ─────────────────

const WAIT_MESSAGE = "Too many requests from this connection. Please wait a moment and try again.";
const DAILY_MESSAGE = "Too many requests today. Please try again tomorrow.";
const BUSY_MESSAGE = "We're a little busy right now. Please try again in a moment.";

const acquireReadSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_READ_BURST", 30),
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

// ── Validation ───────────────────────────────────────────────────────────────
// (Auth — bearer session → patient row — lives in ../lib/patient-auth, shared
// with the patient-media rail.)

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MEALS = new Set(["breakfast", "lunch", "dinner", "snacks"]);
const KINDS = new Set(["food", "recipe", "quick"]);
const PROFILE_CONTACT_SENDS_PER_ACCOUNT_PER_HOUR = 6;
const PROFILE_CODE_ERROR = "That code didn't match or has expired. Check it and try again.";

function timezoneIsValid(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function profileDto(row: Record<string, unknown>) {
  const legacyName = String(row.name ?? "").trim();
  const legacyParts = legacyName.split(/\s+/);
  const firstName = String(row.first_name ?? legacyParts[0] ?? "").trim();
  const lastName = String(row.last_name ?? legacyParts.slice(1).join(" ")).trim();
  return {
    name: [firstName, lastName].filter(Boolean).join(" "),
    firstName,
    lastName,
    email: typeof row.email === "string" ? row.email : null,
    phone: typeof row.phone === "string" ? row.phone : null,
    dateOfBirth: typeof row.date_of_birth === "string" ? row.date_of_birth : null,
    gender: row.gender === "male" || row.gender === "female" ? row.gender : null,
    heightUnit: row.height_unit === "metric" ? "metric" : "imperial",
    heightCm: numericOrNull(row.height_cm),
    heightInches: numericOrNull(row.height_inches),
    startingWeight: numericOrNull(row.starting_weight),
    currentWeight: numericOrNull(row.current_weight),
    goalWeight: numericOrNull(row.goal_weight),
    timezone: typeof row.timezone === "string" ? row.timezone : null,
    programId: typeof row.program_id === "string" ? row.program_id : null,
    program:
      row.program_id === "thinnr" || row.program_id === "glp1" || row.program_id === "none"
        ? row.program_id
        : null,
    programStartDate:
      typeof row.program_start_date === "string" ? row.program_start_date.slice(0, 10) : null,
    emailVerified: typeof row.email_verified_at === "string",
    phoneVerified: typeof row.phone_verified_at === "string",
    setupComplete: typeof row.profile_completed_at === "string",
  };
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function yearsAgoDateKey(years: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

function parseProfilePatch(
  raw: unknown,
  setup: boolean,
): { patch: Record<string, unknown> } | { error: string; field?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Profile details are invalid." };
  const body = raw as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 161) {
      return { error: "Name is invalid.", field: "name" };
    }
    const parts = body.name.trim().replace(/\s+/g, " ").split(" ");
    patch.first_name = parts.shift();
    patch.last_name = parts.join(" ") || null;
    patch.name = body.name.trim().replace(/\s+/g, " ");
  }
  const text = (wire: string, column: string, max: number, required = false) => {
    const value = body[wire];
    if (value === undefined && !required) return null;
    if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
      return { error: `${wire === "firstName" ? "First name" : "Last name"} is invalid.`, field: wire };
    }
    patch[column] = value.trim().replace(/\s+/g, " ");
    return null;
  };
  let issue = text("firstName", "first_name", 80, setup);
  if (issue) return issue;
  issue = text("lastName", "last_name", 80, setup);
  if (issue) return issue;

  if (body.dateOfBirth !== undefined || setup) {
    const dob = body.dateOfBirth;
    const dobTime = typeof dob === "string" && DATE_KEY_RE.test(dob) ? Date.parse(`${dob}T00:00:00Z`) : NaN;
    if (
      !Number.isFinite(dobTime) ||
      new Date(dobTime).toISOString().slice(0, 10) !== dob ||
      dob < yearsAgoDateKey(120) ||
      dob > yearsAgoDateKey(18)
    ) {
      return { error: "Date of birth is invalid.", field: "dateOfBirth" };
    }
    patch.date_of_birth = body.dateOfBirth;
  }
  for (const [wire, column, required] of [
    ["heightInches", "height_inches", setup],
    ["startingWeight", "starting_weight", setup],
    ["currentWeight", "current_weight", setup],
    ["goalWeight", "goal_weight", setup],
  ] as const) {
    const value = body[wire];
    if (value === undefined && !required) continue;
    const min = wire === "heightInches" ? 24 : 40;
    const max = wire === "heightInches" ? 96 : 1500;
    if (!numberIn(value, min, max)) return { error: `${wire} is invalid.`, field: wire };
    patch[column] = value;
  }
  if (body.gender !== undefined) {
    if (body.gender !== null && body.gender !== "male" && body.gender !== "female") {
      return { error: "Gender is invalid.", field: "gender" };
    }
    patch.gender = body.gender;
  }
  if (body.heightUnit !== undefined) {
    if (body.heightUnit !== "imperial" && body.heightUnit !== "metric") {
      return { error: "Height unit is invalid.", field: "heightUnit" };
    }
    patch.height_unit = body.heightUnit;
  }
  if (body.heightCm !== undefined) {
    if (body.heightCm !== null && !numberIn(body.heightCm, 60, 245)) {
      return { error: "Height is invalid.", field: "heightCm" };
    }
    patch.height_cm = body.heightCm;
    if (typeof body.heightCm === "number") patch.height_inches = body.heightCm / 2.54;
  }
  if (body.timezone !== undefined || setup) {
    if (typeof body.timezone !== "string" || body.timezone.length > 100 || !timezoneIsValid(body.timezone)) {
      return { error: "Timezone is invalid.", field: "timezone" };
    }
    patch.timezone = body.timezone;
  }
  if (body.programId !== undefined || (setup && body.program === undefined)) {
    if (typeof body.programId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(body.programId)) {
      return { error: "Program is invalid.", field: "programId" };
    }
    patch.program_id = body.programId;
  }
  if (body.program !== undefined) {
    if (!["thinnr", "glp1", "none", null].includes(body.program as any)) {
      return { error: "Program is invalid.", field: "program" };
    }
    patch.program_id = body.program;
  }
  if (body.programStartDate !== undefined) {
    if (!isDateKey(body.programStartDate)) {
      return { error: "Program start date is invalid.", field: "programStartDate" };
    }
    patch.program_start_date = body.programStartDate;
  }
  if (
    setup &&
    (patch.program_id === "thinnr" || patch.program_id === "glp1") &&
    patch.program_start_date === undefined
  ) {
    return { error: "Program start date is required.", field: "programStartDate" };
  }
  if (Object.keys(patch).length === 0) return { error: "Nothing to save." };
  if (patch.first_name !== undefined || patch.last_name !== undefined) {
    // Filled after loading the current row so a partial update cannot erase a name half.
    patch.__refresh_name = true;
  }
  return { patch };
}

/** Credentials are never patient-data.  Keep this at the API boundary as a
 * defense in depth companion to the database trigger. */
function stripOnboardingPassword(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.password;
  return copy;
}

/** Real calendar date in a sane window, formatted exactly YYYY-MM-DD. */
function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  if (new Date(time).toISOString().slice(0, 10) !== value) return false;
  return value >= "2020-01-01" && value <= "2035-12-31";
}

/**
 * A day key a real device could honestly stamp on new data: valid, and no
 * later than "today" anywhere on Earth (UTC+14) plus a day of clock-skew
 * allowance. Past days stay legal — browsing and deliberate backfill are
 * how the diary works — but far-future keys would strand rows on days the
 * patient won't see for years, so they are rejected at the door.
 */
function isPlausibleDayKey(value: unknown): value is string {
  return isDateKey(value) && value <= maxPlausibleDayKey();
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

const SNAPSHOT_DIMENSIONS = new Set(["weight", "volume", "count", "serving"]);
const SNAPSHOT_PROVENANCE = new Set([
  "generic_source",
  "generic_dish_estimate",
  "identified_product",
  "personal_label",
]);

function snapshotText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/**
 * Validates and bounds an optional FoodNutritionSnapshot without importing a
 * mobile artifact. Null is never a valid supplied snapshot; undefined means
 * the legacy field is absent.
 */
function parseNutritionSnapshot(
  value: unknown,
): { snapshot: Record<string, unknown> | null } | { error: string } {
  if (value === undefined) return { snapshot: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Nutrition snapshot is invalid." };
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { error: "Nutrition snapshot is invalid." };
  }
  if (encoded.length > 64_000) return { error: "Nutrition snapshot is too large." };
  const root = value as Record<string, unknown>;
  const source = root.source as Record<string, unknown> | null;
  const basis = root.basis as Record<string, unknown> | null;
  const selected = root.selected as Record<string, unknown> | null;
  if (
    root.version !== 1 ||
    !source || typeof source !== "object" || Array.isArray(source) ||
    !snapshotText(source.provider, 80) ||
    !snapshotText(source.recordId, 160) ||
    !snapshotText(source.revision, 160) ||
    (source.release !== undefined && !snapshotText(source.release, 160)) ||
    (source.canonicalName !== undefined && !snapshotText(source.canonicalName, 500)) ||
    !basis || typeof basis !== "object" || Array.isArray(basis) ||
    !numberIn(basis.amount, Number.MIN_VALUE, 1_000_000) ||
    !snapshotText(basis.unit, 40) ||
    !snapshotText(basis.label, 160) ||
    (basis.grams !== undefined && !numberIn(basis.grams, Number.MIN_VALUE, 1_000_000)) ||
    !selected || typeof selected !== "object" || Array.isArray(selected) ||
    !numberIn(selected.amount, Number.MIN_VALUE, 1_000_000) ||
    !snapshotText(selected.unitId, 120) ||
    !numberIn(selected.scale, Number.MIN_VALUE, 1_000_000) ||
    typeof root.provenance !== "string" ||
    !SNAPSHOT_PROVENANCE.has(root.provenance) ||
    !Array.isArray(root.nutrients) ||
    root.nutrients.length < 1 ||
    root.nutrients.length > 200 ||
    !Array.isArray(root.portions) ||
    root.portions.length < 1 ||
    root.portions.length > 100
  ) return { error: "Nutrition snapshot is invalid." };

  const nutrientIds = new Set<string>();
  for (const raw of root.nutrients) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Nutrition snapshot is invalid." };
    const nutrient = raw as Record<string, unknown>;
    if (
      !snapshotText(nutrient.id, 120) ||
      nutrientIds.has(nutrient.id) ||
      !snapshotText(nutrient.name, 160) ||
      !snapshotText(nutrient.unit, 40) ||
      !numberIn(nutrient.amount, 0, 10_000_000)
    ) return { error: "Nutrition snapshot is invalid." };
    nutrientIds.add(nutrient.id);
  }
  const portionIds = new Set<string>();
  let selectedMultiplier: number | null = null;
  for (const raw of root.portions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Nutrition snapshot is invalid." };
    const portion = raw as Record<string, unknown>;
    if (
      !snapshotText(portion.id, 120) ||
      portionIds.has(portion.id) ||
      !snapshotText(portion.label, 160) ||
      !snapshotText(portion.unit, 40) ||
      typeof portion.dimension !== "string" ||
      !SNAPSHOT_DIMENSIONS.has(portion.dimension) ||
      !numberIn(portion.basisMultiplier, Number.MIN_VALUE, 1_000_000) ||
      (portion.grams !== undefined && !numberIn(portion.grams, Number.MIN_VALUE, 1_000_000)) ||
      (portion.evidence !== undefined && !snapshotText(portion.evidence, 500))
    ) return { error: "Nutrition snapshot is invalid." };
    portionIds.add(portion.id);
    if (portion.id === selected.unitId) selectedMultiplier = portion.basisMultiplier;
  }
  if (selectedMultiplier === null) return { error: "Nutrition snapshot selected unit is invalid." };
  const expectedScale = (selected.amount as number) * selectedMultiplier;
  if (Math.abs(expectedScale - (selected.scale as number)) > Math.max(1e-10, expectedScale * 1e-10)) {
    return { error: "Nutrition snapshot scale is invalid." };
  }
  if (root.variant !== undefined) {
    const variant = root.variant as Record<string, unknown> | null;
    const dimensions = variant?.dimensions as Record<string, unknown> | null;
    if (
      !variant || typeof variant !== "object" || Array.isArray(variant) ||
      !snapshotText(variant.familyKey, 160) ||
      !snapshotText(variant.summary, 300) ||
      !dimensions || typeof dimensions !== "object" || Array.isArray(dimensions) ||
      Object.keys(dimensions).length > 20
    ) return { error: "Nutrition snapshot variant is invalid." };
    for (const [key, dimensionValue] of Object.entries(dimensions)) {
      if (!snapshotText(key, 80) || !snapshotText(dimensionValue, 160)) {
        return { error: "Nutrition snapshot variant is invalid." };
      }
    }
  }
  return { snapshot: root };
}

/** Array of opaque catalog/custom ids (favorites, recents, deleteIds). */
function parseIdList(value: unknown, maxItems: number, maxLength = 80): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length < 1 || id.length > maxLength) return null;
    out.push(id);
  }
  return out;
}

const PHOTO_ANGLES = new Set(["front", "side", "back"]);

interface CheckInRow {
  patient_id: string;
  date_key: string;
  check_in_id: string;
  weight: number | null;
  mood: number;
  side_effects: string[];
  notes: string | null;
  updated_at: string;
}

/**
 * One check-in from the app, checked field by field into a DB row. Every
 * column rides the payload (weight/notes as explicit nulls when absent) so
 * the same-day merge REPLACES the previous answers instead of blending two
 * submissions together.
 */
function parseCheckIn(raw: unknown, patientId: string): { row: CheckInRow } | { error: string } {
  const checkIn = (raw ?? {}) as Record<string, unknown>;
  if (typeof checkIn.id !== "string" || !ENTRY_ID_RE.test(checkIn.id)) {
    return { error: "A check-in id is invalid." };
  }
  if (!isPlausibleDayKey(checkIn.dateKey)) {
    return { error: "A check-in date is invalid." };
  }
  if (checkIn.weight !== undefined && !numberIn(checkIn.weight, 1, 1500)) {
    return { error: "A check-in weight is invalid." };
  }
  if (!numberIn(checkIn.mood, 1, 5) || !Number.isInteger(checkIn.mood)) {
    return { error: "A check-in mood is invalid." };
  }
  if (
    !Array.isArray(checkIn.sideEffects) ||
    checkIn.sideEffects.length > 12 ||
    checkIn.sideEffects.some(v => typeof v !== "string" || v.length < 1 || v.length > 60)
  ) {
    return { error: "A check-in side-effects list is invalid." };
  }
  if (
    checkIn.notes !== undefined &&
    (typeof checkIn.notes !== "string" || checkIn.notes.length < 1 || checkIn.notes.length > 2000)
  ) {
    return { error: "A check-in note is invalid." };
  }
  return {
    row: {
      patient_id: patientId,
      date_key: checkIn.dateKey,
      check_in_id: checkIn.id,
      weight: checkIn.weight === undefined ? null : (checkIn.weight as number),
      mood: checkIn.mood,
      side_effects: checkIn.sideEffects as string[],
      notes: checkIn.notes === undefined ? null : (checkIn.notes as string),
      updated_at: new Date().toISOString(),
    },
  };
}

interface PhotoRow {
  patient_id: string;
  photo_id: string;
  date_key: string;
  label: string;
  angle: string | null;
  object_path: string;
  updated_at: string;
}

/**
 * One progress-photo grid row from the app. The object path must sit inside
 * THIS patient's media folder with the progress kind prefix — the same
 * ownership-in-the-path rule the media rail and the DB check enforce — so a
 * row can never point at another patient's bytes (or a non-progress object).
 */
function parseProgressPhoto(raw: unknown, patientId: string): { row: PhotoRow } | { error: string } {
  const photo = (raw ?? {}) as Record<string, unknown>;
  if (typeof photo.id !== "string" || !ENTRY_ID_RE.test(photo.id)) {
    return { error: "A photo id is invalid." };
  }
  if (!isPlausibleDayKey(photo.dateKey)) {
    return { error: "A photo date is invalid." };
  }
  if (typeof photo.label !== "string" || photo.label.length < 1 || photo.label.length > 80) {
    return { error: "A photo label is invalid." };
  }
  if (photo.angle !== undefined && (typeof photo.angle !== "string" || !PHOTO_ANGLES.has(photo.angle))) {
    return { error: "A photo angle is invalid." };
  }
  if (
    typeof photo.objectPath !== "string" ||
    !isOwnPatientMediaPath(photo.objectPath, patientId) ||
    !photo.objectPath.startsWith(`${PATIENT_MEDIA_PREFIX}${patientId}/progress-`)
  ) {
    return { error: "A photo isn't on your account's progress rail." };
  }
  return {
    row: {
      patient_id: patientId,
      photo_id: photo.id,
      date_key: photo.dateKey,
      label: photo.label,
      angle: photo.angle === undefined ? null : (photo.angle as string),
      object_path: photo.objectPath,
      updated_at: new Date().toISOString(),
    },
  };
}

interface EntryRow {
  patient_id: string;
  entry_id: string;
  date_key: string;
  meal: string;
  kind: string;
  ref_id: string | null;
  name: string;
  detail: string;
  quantity: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  adjustments: Array<{ index: number; amount: number; unit: string }> | null;
  nutrition_snapshot: Record<string, unknown> | null;
  /** Diet fit verdict the app recorded at log time; null when it recorded none. */
  fit_verdict: "fits" | "does_not_fit" | "unknown" | null;
  updated_at: string;
}

const FIT_VERDICTS = new Set(["fits", "does_not_fit", "unknown"]);

/**
 * One diary entry from the app, checked field by field into a DB row.
 * Snapshots are stored verbatim (no trimming/rewriting) so the row the app
 * wrote optimistically and the row it hydrates later are identical.
 */
function parseEntry(
  raw: unknown,
  patientId: string,
  stamp: string,
): { row: EntryRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Each entry must be an object." };
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !ENTRY_ID_RE.test(e.id)) {
    return { error: "Entry id is invalid." };
  }
  if (!isPlausibleDayKey(e.dateKey)) return { error: "Entry date is invalid." };
  if (typeof e.meal !== "string" || !MEALS.has(e.meal)) {
    return { error: "Entry meal slot is invalid." };
  }
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) {
    return { error: "Entry kind is invalid." };
  }
  const refId = e.refId === undefined || e.refId === null ? null : e.refId;
  if (refId !== null && (typeof refId !== "string" || refId.length < 1 || refId.length > 80)) {
    return { error: "Entry refId is invalid." };
  }
  if (typeof e.name !== "string" || e.name.trim().length < 1 || e.name.length > 200) {
    return { error: "Entry name must be 1-200 characters." };
  }
  const detail = e.detail === undefined ? "" : e.detail;
  if (typeof detail !== "string" || detail.length > 300) {
    return { error: "Entry detail is too long." };
  }
  if (!numberIn(e.quantity, 0, 999) || (e.quantity as number) <= 0) {
    return { error: "Entry quantity is invalid." };
  }
  if (!numberIn(e.calories, 0, 50000)) return { error: "Entry calories are invalid." };
  if (!numberIn(e.protein, 0, 5000)) return { error: "Entry protein is invalid." };
  if (!numberIn(e.carbs, 0, 5000)) return { error: "Entry carbs are invalid." };
  if (!numberIn(e.fat, 0, 5000)) return { error: "Entry fat is invalid." };
  let adjustments: EntryRow["adjustments"] = null;
  if (e.adjustments !== undefined && e.adjustments !== null) {
    if (!Array.isArray(e.adjustments) || e.adjustments.length > 60) {
      return { error: "Entry adjustments are invalid." };
    }
    const cleaned: Array<{ index: number; amount: number; unit: string }> = [];
    for (const item of e.adjustments) {
      if (typeof item !== "object" || item === null) {
        return { error: "Entry adjustments are invalid." };
      }
      const adj = item as Record<string, unknown>;
      if (!numberIn(adj.index, 0, 500) || !Number.isInteger(adj.index)) {
        return { error: "Entry adjustments are invalid." };
      }
      if (!numberIn(adj.amount, 0, 100000)) return { error: "Entry adjustments are invalid." };
      if (typeof adj.unit !== "string" || adj.unit.length > 40) {
        return { error: "Entry adjustments are invalid." };
      }
      cleaned.push({ index: adj.index, amount: adj.amount, unit: adj.unit });
    }
    if (cleaned.length > 0) adjustments = cleaned;
  }
  const nutrition = parseNutritionSnapshot(e.nutritionSnapshot);
  if ("error" in nutrition) return nutrition;
  // Optional: whether the food fit the diet in force when it was logged. The
  // roster's "% fits diet" counts these; an entry without one is not scored.
  let fitVerdict: EntryRow["fit_verdict"] = null;
  if (e.fitVerdict !== undefined && e.fitVerdict !== null) {
    if (typeof e.fitVerdict !== "string" || !FIT_VERDICTS.has(e.fitVerdict)) {
      return { error: "Entry fit verdict is invalid." };
    }
    fitVerdict = e.fitVerdict as EntryRow["fit_verdict"];
  }
  return {
    row: {
      patient_id: patientId,
      entry_id: e.id,
      date_key: e.dateKey,
      meal: e.meal,
      kind: e.kind,
      ref_id: refId,
      name: e.name,
      detail,
      quantity: e.quantity,
      calories: e.calories,
      protein: e.protein,
      carbs: e.carbs,
      fat: e.fat,
      adjustments,
      nutrition_snapshot: nutrition.snapshot,
      fit_verdict: fitVerdict,
      updated_at: stamp,
    },
  };
}

// ── Library validation (custom foods + saved recipes) ───────────────────────

const RECIPE_MODES = new Set(["recipe", "cravings", "meal"]);

/** Optional photo reference: must be a media path under THIS patient's prefix. */
function parsePhotoPath(
  value: unknown,
  patientId: string,
): { path: string | null } | { error: string } {
  if (value === undefined || value === null) return { path: null };
  if (typeof value !== "string" || !isOwnPatientMediaPath(value, patientId)) {
    return { error: "Photo reference is invalid." };
  }
  return { path: value };
}

interface FoodRow {
  food_id: string;
  name: string;
  brand: string | null;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  photo_path: string | null;
  nutrition_snapshot: Record<string, unknown> | null;
  catalog_shared: boolean;
  catalog_metadata: Record<string, unknown> | null;
}

/**
 * One custom food from the app, checked field by field into a DB row.
 * Snapshots are stored verbatim so the item the app wrote optimistically and
 * the item it hydrates later are identical. The category is a client
 * constant ("My Foods") and never stored.
 */
function parseCustomFood(raw: unknown, patientId: string): { row: FoodRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Each food must be an object." };
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !ENTRY_ID_RE.test(f.id)) {
    return { error: "Food id is invalid." };
  }
  if (typeof f.name !== "string" || f.name.trim().length < 1 || f.name.length > 200) {
    return { error: "Food name must be 1-200 characters." };
  }
  const brand = f.brand === undefined || f.brand === null ? null : f.brand;
  if (brand !== null && (typeof brand !== "string" || brand.length < 1 || brand.length > 120)) {
    return { error: "Food brand is invalid." };
  }
  if (typeof f.serving !== "string" || f.serving.length < 1 || f.serving.length > 160) {
    return { error: "Food serving is invalid." };
  }
  if (!numberIn(f.calories, 0, 50000)) return { error: "Food calories are invalid." };
  if (!numberIn(f.protein, 0, 5000)) return { error: "Food protein is invalid." };
  if (!numberIn(f.carbs, 0, 5000)) return { error: "Food carbs are invalid." };
  if (!numberIn(f.fat, 0, 5000)) return { error: "Food fat is invalid." };
  const photo = parsePhotoPath(f.photoPath, patientId);
  if ("error" in photo) return photo;
  const nutrition = parseNutritionSnapshot(f.nutritionSnapshot);
  if ("error" in nutrition) return nutrition;
  const catalogShared = f.catalogShared === true;
  const catalogMetadata: Record<string, unknown> = {};
  for (const [key, max] of [
    ["catalogSourceLabel", 200],
    ["catalogLookupId", 200],
    ["catalogCanonicalName", 500],
  ] as const) {
    if (f[key] !== undefined) {
      if (!snapshotText(f[key], max)) return { error: "Food catalog metadata is invalid." };
      catalogMetadata[key] = f[key];
    }
  }
  if (f.catalogApproved !== undefined) {
    if (typeof f.catalogApproved !== "boolean") return { error: "Food catalog metadata is invalid." };
    catalogMetadata.catalogApproved = f.catalogApproved;
  }
  if (f.catalogServingGrams !== undefined) {
    if (!numberIn(f.catalogServingGrams, Number.MIN_VALUE, 1_000_000)) {
      return { error: "Food catalog metadata is invalid." };
    }
    catalogMetadata.catalogServingGrams = f.catalogServingGrams;
  }
  return {
    row: {
      food_id: f.id,
      name: f.name,
      brand,
      serving: f.serving,
      calories: f.calories,
      protein: f.protein,
      carbs: f.carbs,
      fat: f.fat,
      photo_path: photo.path,
      nutrition_snapshot: nutrition.snapshot,
      catalog_shared: catalogShared,
      catalog_metadata: Object.keys(catalogMetadata).length > 0 ? catalogMetadata : null,
    },
  };
}

interface RecipeRow {
  recipe_id: string;
  name: string;
  meal: string;
  mode: string;
  tags: string[];
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  description: string;
  ingredients: Array<Record<string, unknown>>;
  steps: string[];
  grocery_list: string[] | null;
  saved_at: string;
  photo_path: string | null;
}

/** Array of short strings (tags, steps, grocery list). */
function parseStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > maxLength) return null;
    out.push(item);
  }
  return out;
}

/**
 * One saved AI recipe from the app, checked field by field into a DB row.
 * The recipe is a full self-contained snapshot (per-serving totals plus the
 * coach's original ingredient amounts and per-ingredient nutrition); the
 * source is a client constant ("coach") and never stored.
 */
function parseSavedRecipe(raw: unknown, patientId: string): { row: RecipeRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Each recipe must be an object." };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ENTRY_ID_RE.test(r.id)) {
    return { error: "Recipe id is invalid." };
  }
  if (typeof r.name !== "string" || r.name.trim().length < 1 || r.name.length > 200) {
    return { error: "Recipe name must be 1-200 characters." };
  }
  if (typeof r.meal !== "string" || !MEALS.has(r.meal)) {
    return { error: "Recipe meal slot is invalid." };
  }
  if (typeof r.mode !== "string" || !RECIPE_MODES.has(r.mode)) {
    return { error: "Recipe mode is invalid." };
  }
  const tags = parseStringList(r.tags ?? [], 12, 40);
  if (tags === null) return { error: "Recipe tags are invalid." };
  if (!numberIn(r.minutes, 0, 2000)) return { error: "Recipe minutes are invalid." };
  if (!numberIn(r.servings, 0, 1000)) return { error: "Recipe servings are invalid." };
  if (!numberIn(r.calories, 0, 50000)) return { error: "Recipe calories are invalid." };
  if (!numberIn(r.protein, 0, 5000)) return { error: "Recipe protein is invalid." };
  if (!numberIn(r.carbs, 0, 5000)) return { error: "Recipe carbs are invalid." };
  if (!numberIn(r.fat, 0, 5000)) return { error: "Recipe fat is invalid." };
  const description = r.description === undefined ? "" : r.description;
  if (typeof description !== "string" || description.length > 2000) {
    return { error: "Recipe description is too long." };
  }
  if (!Array.isArray(r.ingredients) || r.ingredients.length > 60) {
    return { error: "Recipe ingredients are invalid." };
  }
  const ingredients: Array<Record<string, unknown>> = [];
  for (const item of r.ingredients) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: "Recipe ingredients are invalid." };
    }
    const ing = item as Record<string, unknown>;
    if (!numberIn(ing.amount, 0, 100000)) return { error: "Recipe ingredients are invalid." };
    if (typeof ing.unit !== "string" || ing.unit.length > 40) {
      return { error: "Recipe ingredients are invalid." };
    }
    if (typeof ing.name !== "string" || ing.name.length < 1 || ing.name.length > 200) {
      return { error: "Recipe ingredients are invalid." };
    }
    const cleaned: Record<string, unknown> = { amount: ing.amount, unit: ing.unit, name: ing.name };
    if (ing.nutrition !== undefined && ing.nutrition !== null) {
      if (typeof ing.nutrition !== "object" || Array.isArray(ing.nutrition)) {
        return { error: "Recipe ingredients are invalid." };
      }
      const n = ing.nutrition as Record<string, unknown>;
      if (
        !numberIn(n.calories, 0, 50000) ||
        !numberIn(n.protein, 0, 5000) ||
        !numberIn(n.carbs, 0, 5000) ||
        !numberIn(n.fat, 0, 5000)
      ) {
        return { error: "Recipe ingredients are invalid." };
      }
      cleaned.nutrition = { calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat };
    }
    ingredients.push(cleaned);
  }
  const steps = parseStringList(r.steps ?? [], 40, 600);
  if (steps === null) return { error: "Recipe steps are invalid." };
  let groceryList: string[] | null = null;
  if (r.groceryList !== undefined && r.groceryList !== null) {
    groceryList = parseStringList(r.groceryList, 80, 200);
    if (groceryList === null) return { error: "Recipe grocery list is invalid." };
  }
  if (typeof r.savedAt !== "string" || r.savedAt.length < 1 || r.savedAt.length > 40) {
    return { error: "Recipe save time is invalid." };
  }
  const photo = parsePhotoPath(r.photoPath, patientId);
  if ("error" in photo) return photo;
  return {
    row: {
      recipe_id: r.id,
      name: r.name,
      meal: r.meal,
      mode: r.mode,
      tags,
      minutes: r.minutes,
      servings: r.servings,
      calories: r.calories,
      protein: r.protein,
      carbs: r.carbs,
      fat: r.fat,
      description,
      ingredients,
      steps,
      grocery_list: groceryList,
      saved_at: r.savedAt,
      photo_path: photo.path,
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const MAX_ENTRIES_RETURNED = 5000;
const MAX_FOODS_RETURNED = 2000;
const MAX_RECIPES_RETURNED = 1000;
const MAX_PHOTOS_RETURNED = 1000;
const MAX_CHECKINS_RETURNED = 400;

const PROFILE_SELECT =
  "id,first_name,last_name,name,email,phone,date_of_birth,gender,height_unit,height_cm,height_inches,starting_weight,current_weight,goal_weight,timezone,program_id,program_start_date,email_verified_at,phone_verified_at,profile_completed_at,created_at";

async function loadCanonicalProfile(patientId: string): Promise<Record<string, unknown>> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&select=${PROFILE_SELECT}&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json) || result.json.length !== 1) {
    throw new Error(`profile lookup failed (${result.status})`);
  }
  return result.json[0] as Record<string, unknown>;
}

router.get("/patient-data/profile", async (req, res) => {
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
    res.json({ profile: profileDto(await loadCanonicalProfile(auth.patientId)) });
  } catch (error) {
    req.log?.error({ err: error }, "patient profile read failed");
    res.status(502).json({ error: "Couldn't load your profile right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

async function saveProfile(req: any, res: any, setup: boolean): Promise<void> {
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profileInput =
      body.profile && typeof body.profile === "object" && !Array.isArray(body.profile)
        ? body.profile
        : body;
    const parsed = parseProfilePatch(profileInput, setup);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }
    if (
      body.profile !== undefined &&
      (!body.onboardingAnswers ||
        typeof body.onboardingAnswers !== "object" ||
        Array.isArray(body.onboardingAnswers))
    ) {
      res.status(400).json({ error: "Onboarding answers are invalid.", field: "onboardingAnswers" });
      return;
    }
    if (
      body.notificationPrefs !== undefined &&
      (!body.notificationPrefs ||
        typeof body.notificationPrefs !== "object" ||
        Array.isArray(body.notificationPrefs))
    ) {
      res.status(400).json({ error: "Notification preferences are invalid.", field: "notificationPrefs" });
      return;
    }
    const current = await loadCanonicalProfile(auth.patientId);
    if (setup && (!String(current.email ?? "").trim() || !String(current.phone ?? "").trim())) {
      res.status(400).json({
        error: "A verified email and phone number are required before setup can finish.",
        field: "contact",
      });
      return;
    }
    const patch = parsed.patch;
    if (patch.__refresh_name) {
      delete patch.__refresh_name;
      const first = String(patch.first_name ?? current.first_name ?? "").trim();
      const last = String(patch.last_name ?? current.last_name ?? "").trim();
      patch.name = [first, last].filter(Boolean).join(" ");
    }
    const atomicSetup = setup || body.profile !== undefined;
    const saved = atomicSetup
      ? await supabaseAdmin("POST", "/rest/v1/rpc/patient_apply_profile_setup", {
          p_patient_id: auth.patientId,
          p_auth_user_id: auth.authUserId,
          p_profile: patch,
          p_onboarding_answers: stripOnboardingPassword(body.onboardingAnswers ?? {}),
          p_notification_prefs: body.notificationPrefs ?? null,
          p_complete: setup,
        })
      : await supabaseAdmin(
          "PATCH",
          `/rest/v1/patients?id=eq.${enc(auth.patientId)}&auth_user_id=eq.${enc(auth.authUserId)}&archived_at=is.null`,
          { ...patch, profile_updated_at: new Date().toISOString() },
          "return=representation",
        );
    const savedRow = Array.isArray(saved.json) ? saved.json[0] : saved.json;
    if (saved.status >= 300 || !savedRow || typeof savedRow !== "object") {
      throw new Error(`profile update failed (${saved.status})`);
    }
    if (setup) {
      // Finishing setup seeds the medication list from the program choice
      // (protocol drops three times a day / weekly GLP-1 injection). Only an
      // empty list is seeded, so a retry or a re-run of setup never
      // duplicates records the patient has since edited.
      const row = savedRow as Record<string, unknown>;
      const startDate =
        typeof row.program_start_date === "string" && isDateKey(row.program_start_date.slice(0, 10))
          ? row.program_start_date.slice(0, 10)
          : dayKeyInTimeZone(typeof row.timezone === "string" ? row.timezone : null);
      await seedMedicationsFromOnboarding(auth.patientId, body.onboardingAnswers ?? {}, startDate);
    }
    res.json({ profile: profileDto(savedRow as Record<string, unknown>) });
  } catch (error) {
    req.log?.error({ err: error }, "patient profile write failed");
    res.status(502).json({ error: "Couldn't save your profile right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
}

router.put("/patient-data/profile", (req, res) => void saveProfile(req, res, false));
router.post("/patient-data/profile/setup", (req, res) => void saveProfile(req, res, true));
router.put("/patient-data/setup", (req, res) => void saveProfile(req, res, false));
router.post("/patient-data/setup/complete", (req, res) => void saveProfile(req, res, true));

const contactVerificationStart = async (req: any, res: any) => {
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
    const kind = (req.body ?? {}).kind;
    const identifier = normalizeIdentifier((req.body ?? {}).value);
    if (
      (kind !== "email" && kind !== "phone") ||
      !identifier ||
      identifier.kind !== kind
    ) {
      res.status(400).json({ error: `Enter a valid ${kind === "phone" ? "mobile number" : "email address"}.`, field: "value" });
      return;
    }
    const channel = kind === "phone" ? "sms" : "email";
    try {
      assertLiveChannelReady(channel);
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
    const stored = identifier.kind === "phone" ? identifier.e164 : identifier.email;
    const mode = deliveryMode(channel);
    const delivery = mode === "dev" ? "dev" : kind === "phone" ? "twilio_verify" : "resend";
    const localCode = delivery === "twilio_verify" ? null : generateCode();
    const salt = localCode ? crypto.randomBytes(16).toString("hex") : null;
    const inserted = await supabaseAdmin("POST", "/rest/v1/rpc/claim_register_send", {
      p_purpose: kind === "phone" ? "profile_phone" : "profile_email",
      p_identifier_kind: kind,
      p_identifier: stored,
      p_account_type: "patient",
      p_candidates: [],
      p_delivery: delivery,
      p_code_salt: salt,
      p_code_hash: localCode && salt ? sha256(salt + localCode) : null,
      p_code_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      p_auth_user_id: auth.authUserId,
      p_scope_key: `profile:${auth.authUserId}`,
      p_max_per_hour: SENDS_PER_IDENTIFIER_PER_HOUR,
      p_scope_max_per_hour: PROFILE_CONTACT_SENDS_PER_ACCOUNT_PER_HOUR,
    });
    if (inserted.status >= 300 || !Array.isArray(inserted.json)) {
      throw new Error(`profile contact send registration failed (${inserted.status})`);
    }
    if (inserted.json.length === 0) {
      res.status(429).json({ error: "Too many codes sent just now. Please wait an hour and try again.", retryable: true });
      return;
    }
    const row = inserted.json[0] as { id?: unknown };
    if (delivery === "twilio_verify") await startTwilioVerification(stored);
    if (delivery === "resend" && localCode) await sendClaimEmail(stored, localCode);
    res.json({
      ok: true,
      requestId: row.id,
      message: `We sent a verification code to that ${kind === "phone" ? "number" : "email address"}.`,
      ...(localCode ? { devCode: localCode } : {}),
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient contact verification start failed");
    res.status(502).json({ error: "Couldn't send a verification code right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
};
router.post("/patient-data/profile/contact/start", contactVerificationStart);
router.post("/patient-data/profile/verification/request", contactVerificationStart);

const contactVerificationConfirm = async (req: any, res: any) => {
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
    let { requestId, code } = req.body ?? {};
    const requestedKind = (req.body ?? {}).kind;
    const requestedIdentifier = normalizeIdentifier((req.body ?? {}).value);
    if (
      !requestId &&
      requestedIdentifier &&
      (requestedKind === "email" || requestedKind === "phone") &&
      requestedIdentifier.kind === requestedKind
    ) {
      const stored =
        requestedIdentifier.kind === "phone" ? requestedIdentifier.e164 : requestedIdentifier.email;
      const latest = await supabaseAdmin(
        "GET",
        `/rest/v1/claim_verifications?auth_user_id=eq.${enc(auth.authUserId)}` +
          `&purpose=eq.profile_${requestedKind}&identifier=eq.${enc(stored)}` +
          "&consumed_at=is.null&select=*&order=created_at.desc&limit=1",
      );
      if (latest.status >= 300) throw new Error(`profile verification lookup failed (${latest.status})`);
      requestId = Array.isArray(latest.json) ? latest.json[0]?.id : null;
    }
    if (!isUuid(requestId) || !isCodeShaped(code)) {
      res.status(400).json({ error: PROFILE_CODE_ERROR });
      return;
    }
    const row = await loadRowById(requestId);
    if (
      !row ||
      !["profile_email", "profile_phone"].includes(row.purpose) ||
      row.auth_user_id !== auth.authUserId ||
      row.consumed_at ||
      row.verified_at ||
      row.code_attempts >= MAX_CODE_ATTEMPTS ||
      !row.code_expires_at ||
      new Date(row.code_expires_at).getTime() < Date.now() ||
      !(await takeAttempt(row))
    ) {
      res.status(400).json({ error: PROFILE_CODE_ERROR });
      return;
    }
    const matched =
      row.delivery === "twilio_verify"
        ? await checkTwilioVerification(row.identifier, code)
        : codeMatches(row, code);
    if (!matched) {
      res.status(400).json({ error: PROFILE_CODE_ERROR });
      return;
    }
    const changed = await supabaseAdmin("POST", "/rest/v1/rpc/patient_apply_verified_contact", {
      p_patient_id: auth.patientId,
      p_auth_user_id: auth.authUserId,
      p_verification_id: row.id,
    });
    if (changed.status >= 300) {
      const message = String(changed.json?.message ?? "");
      if (/unique|duplicate/i.test(message)) {
        res.status(409).json({
          error: `That ${row.purpose === "profile_phone" ? "phone number" : "email address"} is already connected to another account.`,
        });
        return;
      }
      throw new Error(`verified contact transaction failed (${changed.status})`);
    }
    const result = Array.isArray(changed.json) ? changed.json[0] : changed.json;
    res.json({ ok: true, profile: profileDto(result as Record<string, unknown>) });
  } catch (error) {
    if (error instanceof DeliveryNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    req.log?.error({ err: error }, "patient contact verification failed");
    res.status(502).json({ error: "Couldn't update your contact details right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
};
router.post("/patient-data/profile/contact/verify", contactVerificationConfirm);
router.post("/patient-data/profile/verification/confirm", contactVerificationConfirm);

router.get("/patient-data/state", async (req, res) => {
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
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    // The app sends its own calendar day; when it doesn't, the patient's
    // stored timezone decides after the profile row arrives below — the
    // server's UTC clock never does (it flips to tomorrow mid-evening for
    // US patients).
    const todayParam = typeof req.query.today === "string" ? req.query.today : null;
    if (
      (from !== null && !isDateKey(from)) ||
      (to !== null && !isDateKey(to)) ||
      (todayParam !== null && !isPlausibleDayKey(todayParam))
    ) {
      res.status(400).json({ error: "Invalid date range." });
      return;
    }
    const pid = enc(auth.patientId);
    const rangeFilters = (prefix: string[]) => {
      const filters = [...prefix];
      if (from) filters.push(`date_key=gte.${from}`);
      if (to) filters.push(`date_key=lte.${to}`);
      return filters.join("&");
    };
    // Photos, check-ins, and flags are deliberately NOT range-filtered: the
    // grid shows every photo the account owns, the weight chart wants the
    // whole weigh-in history, and flags are a singleton.
    const [entries, water, targets, prefs, foods, recipes, photos, checkIns, flags, profile, privacy, medicationState] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_diary_entries?${rangeFilters([`patient_id=eq.${pid}`])}` +
          `&select=entry_id,date_key,meal,kind,ref_id,name,detail,quantity,calories,protein,carbs,fat,adjustments,nutrition_snapshot,fit_verdict` +
          `&order=created_at.asc,entry_id.asc&limit=${MAX_ENTRIES_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_water_days?${rangeFilters([`patient_id=eq.${pid}`])}&select=date_key,oz&limit=400`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_target_overrides?patient_id=eq.${pid}&select=calories,protein,carbs,fat,water_oz`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_food_prefs?patient_id=eq.${pid}&select=favorites,recents`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_custom_foods?patient_id=eq.${pid}` +
          `&select=food_id,name,brand,serving,calories,protein,carbs,fat,photo_path,nutrition_snapshot,catalog_shared,catalog_metadata` +
          `&order=created_at.asc,food_id.asc&limit=${MAX_FOODS_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_saved_recipes?patient_id=eq.${pid}` +
          `&select=recipe_id,name,meal,mode,tags,minutes,servings,calories,protein,carbs,fat,description,ingredients,steps,grocery_list,saved_at,photo_path` +
          `&order=created_at.asc,recipe_id.asc&limit=${MAX_RECIPES_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_progress_photos?patient_id=eq.${pid}` +
          `&select=photo_id,date_key,label,angle,object_path` +
          `&order=created_at.asc,photo_id.asc&limit=${MAX_PHOTOS_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_check_ins?patient_id=eq.${pid}` +
          `&select=check_in_id,date_key,weight,mood,side_effects,notes` +
          `&order=date_key.asc&limit=${MAX_CHECKINS_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_flags?patient_id=eq.${pid}` +
          `&select=nudge_opt_out,nudge_engaged,nudge_last_sent_key,nudge_last_crossing_key,onboarding_complete,onboarding_answers,notification_prefs`,
      ),
      loadCanonicalProfile(auth.patientId),
      // Consent / export / deletion facts ride the same hydration so the
      // route guard can gate on server truth before any screen renders.
      loadPrivacyState(auth.patientId),
      // Medication list + trailing dose logs (reminders and the check-in
      // card are derived from these on the device).
      loadMedicationState(auth.patientId, todayParam ?? dayKeyInTimeZone(null)),
    ]);
    for (const r of [entries, water, targets, prefs, foods, recipes, photos, checkIns, flags]) {
      if (r.status >= 300 || !Array.isArray(r.json)) throw new Error(`state fetch failed (${r.status})`);
    }

    const entryList = (entries.json as Array<Record<string, unknown>>).map(row => {
      const entry: Record<string, unknown> = {
        id: row.entry_id,
        dateKey: String(row.date_key),
        meal: row.meal,
        kind: row.kind,
        name: row.name,
        detail: typeof row.detail === "string" ? row.detail : "",
        quantity: Number(row.quantity),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
      };
      if (typeof row.ref_id === "string" && row.ref_id.length > 0) entry.refId = row.ref_id;
      if (Array.isArray(row.adjustments) && row.adjustments.length > 0) {
        entry.adjustments = row.adjustments;
      }
      if (row.nutrition_snapshot && typeof row.nutrition_snapshot === "object") {
        entry.nutritionSnapshot = row.nutrition_snapshot;
      }
      if (typeof row.fit_verdict === "string" && FIT_VERDICTS.has(row.fit_verdict)) entry.fitVerdict = row.fit_verdict;
      return entry;
    });

    const waterMap: Record<string, number> = {};
    for (const row of water.json as Array<Record<string, unknown>>) {
      waterMap[String(row.date_key)] = Number(row.oz);
    }

    const targetRow = (targets.json as Array<Record<string, unknown>>)[0];
    const targetOverrides: Record<string, number> = {};
    if (targetRow) {
      if (typeof targetRow.calories === "number") targetOverrides.calories = targetRow.calories;
      if (typeof targetRow.protein === "number") targetOverrides.protein = targetRow.protein;
      if (typeof targetRow.carbs === "number") targetOverrides.carbs = targetRow.carbs;
      if (typeof targetRow.fat === "number") targetOverrides.fat = targetRow.fat;
      if (typeof targetRow.water_oz === "number") targetOverrides.waterOz = targetRow.water_oz;
    }

    const prefRow = (prefs.json as Array<Record<string, unknown>>)[0];
    const favorites = Array.isArray(prefRow?.favorites)
      ? (prefRow.favorites as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const recents = Array.isArray(prefRow?.recents)
      ? (prefRow.recents as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    // Library rows come back in the app's own shapes. Constants the client
    // owns (custom-food category, recipe source) are injected here, not
    // stored; photo paths ride as photoPath and the app builds display URLs.
    const allFoodRows = (foods.json as Array<Record<string, unknown>>).map(row => {
      const item: Record<string, unknown> = {
        id: row.food_id,
        name: row.name,
        serving: row.serving,
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        category: "My Foods",
      };
      if (typeof row.brand === "string" && row.brand.length > 0) item.brand = row.brand;
      if (typeof row.photo_path === "string" && row.photo_path.length > 0) {
        item.photoPath = row.photo_path;
      }
      if (row.nutrition_snapshot && typeof row.nutrition_snapshot === "object") {
        item.nutritionSnapshot = row.nutrition_snapshot;
      }
      if (row.catalog_shared === true) item.catalogShared = true;
      if (row.catalog_metadata && typeof row.catalog_metadata === "object") {
        Object.assign(item, row.catalog_metadata);
      }
      return item;
    });
    const customFoods = allFoodRows.filter(item => item.catalogShared !== true);
    const catalogFoods = allFoodRows.filter(item => item.catalogShared === true);

    const savedRecipes = (recipes.json as Array<Record<string, unknown>>).map(row => {
      const item: Record<string, unknown> = {
        id: row.recipe_id,
        name: row.name,
        meal: row.meal,
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
        source: "coach",
        mode: row.mode,
        savedAt: row.saved_at,
      };
      if (Array.isArray(row.grocery_list) && row.grocery_list.length > 0) {
        item.groceryList = row.grocery_list;
      }
      if (typeof row.photo_path === "string" && row.photo_path.length > 0) {
        item.photoPath = row.photo_path;
      }
      return item;
    });

    const photoList = (photos.json as Array<Record<string, unknown>>).map(row => {
      const item: Record<string, unknown> = {
        id: row.photo_id,
        dateKey: String(row.date_key),
        label: row.label,
        objectPath: row.object_path,
      };
      if (typeof row.angle === "string" && row.angle.length > 0) item.angle = row.angle;
      return item;
    });

    const checkInList = (checkIns.json as Array<Record<string, unknown>>).map(row => {
      const item: Record<string, unknown> = {
        id: row.check_in_id,
        dateKey: String(row.date_key),
        mood: Number(row.mood),
        sideEffects: Array.isArray(row.side_effects) ? row.side_effects : [],
      };
      if (typeof row.weight === "number") item.weight = row.weight;
      else if (typeof row.weight === "string" && row.weight.length > 0) item.weight = Number(row.weight);
      if (typeof row.notes === "string" && row.notes.length > 0) item.notes = row.notes;
      return item;
    });

    const flagRow = (flags.json as Array<Record<string, unknown>>)[0];
    const flagsOut: Record<string, unknown> = {
      nudgeOptOut: flagRow?.nudge_opt_out === true,
      nudgeEngaged: flagRow?.nudge_engaged === true,
      nudgeLastSentKey:
        typeof flagRow?.nudge_last_sent_key === "string" ? flagRow.nudge_last_sent_key : null,
      nudgeLastCrossingKey:
        typeof flagRow?.nudge_last_crossing_key === "string" ? flagRow.nudge_last_crossing_key : null,
      onboardingComplete: flagRow?.onboarding_complete === true,
    };
    if (flagRow?.onboarding_answers && typeof flagRow.onboarding_answers === "object") {
      flagsOut.onboardingAnswers = stripOnboardingPassword(flagRow.onboarding_answers);
    }
    if (flagRow?.notification_prefs && typeof flagRow.notification_prefs === "object") {
      flagsOut.notificationPrefs = flagRow.notification_prefs;
    }
    const today =
      todayParam ??
      dayKeyInTimeZone(typeof profile.timezone === "string" ? profile.timezone : null);
    // Legacy records may not have a program_start_date. Their clinical-row
    // created_at is the documented anchor fallback, matching coach grounding.
    const startRaw = profile.program_start_date ?? profile.created_at ?? today;
    const canonicalProfile = profileDto(profile);
    const programStartDate = isDateKey(String(startRaw).slice(0, 10))
      ? String(startRaw).slice(0, 10)
      : today;

    res.json({
      entries: entryList,
      water: waterMap,
      targets: targetOverrides,
      favorites,
      recents,
      customFoods,
      catalogFoods,
      savedRecipes,
      photos: photoList,
      checkIns: checkInList,
      flags: flagsOut,
      medications: medicationState.medications,
      doseLogs: medicationState.doseLogs,
      entry: {
        firstName: firstNameOf(canonicalProfile.name),
        programStartDate,
        todayKey: today,
        programDay: programDayFor(
          {
            program_start_date:
              typeof profile.program_start_date === "string" ? profile.program_start_date : null,
            created_at: typeof profile.created_at === "string" ? profile.created_at : null,
          },
          today,
        ),
      },
      ...(profile.profile_completed_at || profile.first_name
        ? { profile: canonicalProfile }
        : {}),
      privacy,
      // Read capability for this patient's media: display URLs the client
      // builds append it, and GET /patient-media/file requires it.
      mediaToken: mintPatientMediaToken(auth.patientId),
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data state fetch failed");
    res.status(502).json({ error: "Couldn't load your diary right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.get("/patient-data/rewards", async (req, res) => {
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
    const today = typeof req.query.today === "string" ? req.query.today : undefined;
    if (today !== undefined && !isPlausibleDayKey(today)) {
      res.status(400).json({ error: "Invalid reward date." });
      return;
    }
    const rewards = await reconcilePatientRewards(auth.patientId, today);
    res.json(rewards);
  } catch (error) {
    req.log?.error({ err: error }, "patient rewards fetch failed");
    res.status(502).json({ error: "Couldn't load your rewards right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/patient-data/entries", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "entries");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    let upsertRaw: unknown[] = [];
    if (body.upsert !== undefined) {
      if (!Array.isArray(body.upsert) || body.upsert.length > 80) {
        res.status(400).json({ error: "Entry batch is invalid (at most 80 entries)." });
        return;
      }
      upsertRaw = body.upsert;
    }
    let deleteIds: string[] = [];
    if (body.deleteIds !== undefined) {
      const parsed = parseIdList(body.deleteIds, 200, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Delete list is invalid." });
        return;
      }
      deleteIds = parsed;
    }
    let recents: string[] | undefined;
    if (body.recents !== undefined) {
      const parsed = parseIdList(body.recents, 50);
      if (parsed === null) {
        res.status(400).json({ error: "Recents list is invalid." });
        return;
      }
      recents = parsed;
    }
    if (upsertRaw.length === 0 && deleteIds.length === 0 && recents === undefined) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }

    const stamp = new Date().toISOString();
    const rows: EntryRow[] = [];
    for (const raw of upsertRaw) {
      const parsed = parseEntry(raw, auth.patientId, stamp);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      rows.push(parsed.row);
    }

    // The whole mutation — upserts, deletes, and the recents bump — lands in
    // ONE transaction via the patient_diary_apply function, so a mid-write
    // failure can never strand part of it on the server while the app rolls
    // back its optimistic state. The function takes patient identity from
    // p_patient_id alone and assigns created_at itself (preserved on merge).
    const applied = await supabaseAdmin("POST", "/rest/v1/rpc/patient_diary_apply", {
      p_patient_id: auth.patientId,
      p_upsert: rows,
      p_delete_ids: deleteIds,
      p_recents: recents ?? null,
    });
    if (applied.status >= 300) throw new Error(`diary apply failed (${applied.status})`);
    // HQ Insights: one food_log event per NEWLY created entry. The apply RPC
    // returns the entry ids it inserted, so edits of an existing entry (and
    // deletes) record nothing; the event is keyed on the entry so a replayed
    // create cannot count twice either.
    const created = Array.isArray(applied.json) ? applied.json.filter((id): id is string => typeof id === "string") : [];
    recordPatientEvent(auth.patientId, "food_log", {
      headers: req.headers,
      sourceKeys: created.map((entryId) => `${auth.patientId}:${entryId}`),
    });
    void reconcilePatientRewards(auth.patientId).catch((error) =>
      req.log?.error({ err: error }, "patient rewards reconciliation deferred"),
    );

    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data entries write failed");
    res.status(502).json({ error: "Couldn't save to your diary right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/water", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "water");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isPlausibleDayKey(body.dateKey)) {
      res.status(400).json({ error: "Water date is invalid." });
      return;
    }
    if (!numberIn(body.oz, 0, 200) || !Number.isInteger(body.oz)) {
      res.status(400).json({ error: "Water ounces are invalid." });
      return;
    }
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_water_days?on_conflict=patient_id,date_key",
      [
        {
          patient_id: auth.patientId,
          date_key: body.dateKey,
          oz: body.oz,
          updated_at: new Date().toISOString(),
        },
      ],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`water upsert failed (${upsert.status})`);
    // HQ Insights: each save with water on the day is one water_log event.
    if ((body.oz as number) > 0) recordPatientEvent(auth.patientId, "water_log", { headers: req.headers });
    void reconcilePatientRewards(auth.patientId).catch((error) =>
      req.log?.error({ err: error }, "patient rewards reconciliation deferred"),
    );
    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data water write failed");
    res.status(502).json({ error: "Couldn't save your water right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/targets", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "targets");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { patient_id: auth.patientId };
    if (body.calories !== undefined) {
      if (!numberIn(body.calories, 0, 20000)) {
        res.status(400).json({ error: "Calorie target is invalid." });
        return;
      }
      row.calories = body.calories;
    }
    if (body.protein !== undefined) {
      if (!numberIn(body.protein, 0, 2000)) {
        res.status(400).json({ error: "Protein target is invalid." });
        return;
      }
      row.protein = body.protein;
    }
    if (body.carbs !== undefined) {
      if (!numberIn(body.carbs, 0, 2000)) {
        res.status(400).json({ error: "Carb target is invalid." });
        return;
      }
      row.carbs = body.carbs;
    }
    if (body.fat !== undefined) {
      if (!numberIn(body.fat, 0, 2000)) {
        res.status(400).json({ error: "Fat target is invalid." });
        return;
      }
      row.fat = body.fat;
    }
    if (body.waterOz !== undefined) {
      if (!numberIn(body.waterOz, 0, 200)) {
        res.status(400).json({ error: "Water target is invalid." });
        return;
      }
      row.water_oz = body.waterOz;
    }
    if (Object.keys(row).length === 1) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }
    row.updated_at = new Date().toISOString();
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_target_overrides?on_conflict=patient_id",
      [row],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`target upsert failed (${upsert.status})`);
    void reconcilePatientRewards(auth.patientId).catch((error) =>
      req.log?.error({ err: error }, "patient rewards reconciliation deferred"),
    );
    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data targets write failed");
    res.status(502).json({ error: "Couldn't save your targets right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/prefs", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "prefs");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { patient_id: auth.patientId };
    if (body.favorites !== undefined) {
      const favorites = parseIdList(body.favorites, 500);
      if (favorites === null) {
        res.status(400).json({ error: "Favorites list is invalid." });
        return;
      }
      row.favorites = favorites;
    }
    if (body.recents !== undefined) {
      const recents = parseIdList(body.recents, 50);
      if (recents === null) {
        res.status(400).json({ error: "Recents list is invalid." });
        return;
      }
      row.recents = recents;
    }
    if (Object.keys(row).length === 1) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }
    row.updated_at = new Date().toISOString();
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_food_prefs?on_conflict=patient_id",
      [row],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`prefs upsert failed (${upsert.status})`);
    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data prefs write failed");
    res.status(502).json({ error: "Couldn't save your preferences right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/patient-data/library", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "library");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const foodRows: FoodRow[] = [];
    if (body.foodUpsert !== undefined) {
      if (!Array.isArray(body.foodUpsert) || body.foodUpsert.length > 40) {
        res.status(400).json({ error: "Food batch is invalid (at most 40 foods)." });
        return;
      }
      for (const raw of body.foodUpsert) {
        const parsed = parseCustomFood(raw, auth.patientId);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        foodRows.push(parsed.row);
      }
    }

    const recipeRows: RecipeRow[] = [];
    if (body.recipeUpsert !== undefined) {
      if (!Array.isArray(body.recipeUpsert) || body.recipeUpsert.length > 20) {
        res.status(400).json({ error: "Recipe batch is invalid (at most 20 recipes)." });
        return;
      }
      for (const raw of body.recipeUpsert) {
        const parsed = parseSavedRecipe(raw, auth.patientId);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        recipeRows.push(parsed.row);
      }
    }

    let foodDeleteIds: string[] = [];
    if (body.foodDeleteIds !== undefined) {
      const parsed = parseIdList(body.foodDeleteIds, 200, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Food delete list is invalid." });
        return;
      }
      foodDeleteIds = parsed;
    }
    let recipeDeleteIds: string[] = [];
    if (body.recipeDeleteIds !== undefined) {
      const parsed = parseIdList(body.recipeDeleteIds, 200, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Recipe delete list is invalid." });
        return;
      }
      recipeDeleteIds = parsed;
    }

    let favorites: string[] | null = null;
    if (body.favorites !== undefined) {
      favorites = parseIdList(body.favorites, 500);
      if (favorites === null) {
        res.status(400).json({ error: "Favorites list is invalid." });
        return;
      }
    }
    let recents: string[] | null = null;
    if (body.recents !== undefined) {
      recents = parseIdList(body.recents, 50);
      if (recents === null) {
        res.status(400).json({ error: "Recents list is invalid." });
        return;
      }
    }

    if (
      foodRows.length === 0 &&
      recipeRows.length === 0 &&
      foodDeleteIds.length === 0 &&
      recipeDeleteIds.length === 0 &&
      favorites === null &&
      recents === null
    ) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }

    // The whole mutation — item upserts, deletes, the photo-ledger
    // bookkeeping, and the favorites/recents lists that ride a delete —
    // lands in ONE transaction via the patient_library_apply function, so a
    // mid-write failure can never strand the account between an item and
    // its prefs, or leave a deleted item's photo still referenced. The
    // function takes patient identity from p_patient_id alone, preserves
    // created_at on merge, and keeps the patient_media ledger in lockstep
    // (replaced photos de-referenced, upserted paths re-registered, deleted
    // items' photos dropped).
    const applied = await supabaseAdmin("POST", "/rest/v1/rpc/patient_library_apply", {
      p_patient_id: auth.patientId,
      p_food_upsert: foodRows,
      p_food_delete_ids: foodDeleteIds,
      p_recipe_upsert: recipeRows,
      p_recipe_delete_ids: recipeDeleteIds,
      p_favorites: favorites,
      p_recents: recents,
    });
    if (applied.status >= 300) throw new Error(`library apply failed (${applied.status})`);

    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data library write failed");
    res.status(502).json({ error: "Couldn't save your library right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/patient-data/check-ins", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "check-ins");
    if (idem.handled) return;
    const parsed = parseCheckIn(req.body, auth.patientId);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // The day's prior weight, read before the merge so a re-submitted
    // check-in appends the overwritten value to the edit history.
    const prior = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_check_ins?patient_id=eq.${enc(auth.patientId)}&date_key=eq.${enc(parsed.row.date_key)}&select=weight&limit=1`,
    );
    if (prior.status >= 300) throw new Error(`check-in lookup failed (${prior.status})`);
    const priorRow = Array.isArray(prior.json) ? (prior.json[0] as { weight?: number | string | null } | undefined) : undefined;
    // One row per day: the merge lands every column, so a same-day
    // re-submit replaces the previous answers (id included) wholesale.
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_check_ins?on_conflict=patient_id,date_key",
      [parsed.row],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`check-in upsert failed (${upsert.status})`);
    const weightChange = changedFields(
      { weight: priorRow?.weight == null ? null : Number(priorRow.weight) },
      { weight: parsed.row.weight },
      ["weight"],
    );
    if (weightChange.length > 0) {
      recordPatientEditHistory({
        patientId: auth.patientId,
        family: "weight",
        recordId: `check-in:${parsed.row.date_key}`,
        changeKind: priorRow ? "update" : "create",
        actorKind: "patient",
        actorUserId: auth.authUserId,
        actorName: null,
        auditEventId: null,
        fields: weightChange,
      }).catch((error) => req.log?.error({ err: error }, "patient check-in history failed"));
    }
    // HQ Insights: a check-in that carries a weight is one weigh_in event.
    if (parsed.row.weight != null) recordPatientEvent(auth.patientId, "weigh_in", { headers: req.headers });
    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data check-in write failed");
    res.status(502).json({ error: "Couldn't save your check-in right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/patient-data/health-measurements", async (req, res) => {
  const release = acquireWriteSlot(clientIp(req));
  if (!release.ok) {
    res.status(release.status).json({ error: release.message });
    return;
  }
  try {
    const patient = await resolvePatient(req);
    if (!patient.ok) {
      res.status(patient.status).json({ error: patient.error });
      return;
    }
    const raw = (req.body as { measurements?: unknown } | null)?.measurements;
    if (!Array.isArray(raw) || raw.length > 500) {
      res.status(400).json({ error: "Health measurements are invalid." });
      return;
    }
    const rows: Record<string, unknown>[] = [];
    const now = Date.now();
    const earliest = now - 31 * 24 * 60 * 60 * 1000;
    const latest = now + 5 * 60 * 1000;
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        res.status(400).json({ error: "Health measurements are invalid." });
        return;
      }
      const m = item as Record<string, unknown>;
      const time = typeof m.measuredAt === "string" ? Date.parse(m.measuredAt) : NaN;
      const validKind = m.kind === "weight_lb" || m.kind === "steps";
      const validSource = m.source === "apple_health" || m.source === "health_connect";
      const validValue =
        typeof m.value === "number" && Number.isFinite(m.value) &&
        (m.kind === "weight_lb"
          ? m.value >= 40 && m.value <= 1500
          : Number.isInteger(m.value) && m.value >= 0 && m.value <= 250000);
      if (
        typeof m.sourceId !== "string" || m.sourceId.length < 1 || m.sourceId.length > 300 ||
        !validKind || !validSource || !validValue || !Number.isFinite(time) || time < earliest || time > latest
      ) {
        res.status(400).json({ error: "A health measurement is invalid." });
        return;
      }
      rows.push({
        patient_id: patient.patientId,
        source: m.source,
        source_id: m.sourceId,
        kind: m.kind,
        value: m.value,
        measured_at: new Date(time).toISOString(),
        imported_at: new Date().toISOString(),
      });
    }
    if (rows.length > 0) {
      const upsert = await supabaseAdmin(
        "POST",
        "/rest/v1/patient_health_measurements?on_conflict=patient_id,source,source_id",
        rows,
        "resolution=ignore-duplicates,return=minimal",
      );
      if (upsert.status >= 300) throw new Error(`health measurement upsert failed (${upsert.status})`);
    }
    res.json({ imported: rows.length });
  } catch {
    res.status(503).json({ error: BUSY_MESSAGE });
  } finally {
    release.ok && release.release();
  }
});

router.post("/patient-data/photos", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "photos");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const photoRows: PhotoRow[] = [];
    if (body.upsert !== undefined) {
      if (!Array.isArray(body.upsert) || body.upsert.length > 20) {
        res.status(400).json({ error: "Photo batch is invalid (at most 20 photos)." });
        return;
      }
      for (const raw of body.upsert) {
        const parsed = parseProgressPhoto(raw, auth.patientId);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        photoRows.push(parsed.row);
      }
    }

    let deleteIds: string[] = [];
    if (body.deleteIds !== undefined) {
      const parsed = parseIdList(body.deleteIds, 50, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Photo delete list is invalid." });
        return;
      }
      deleteIds = parsed;
    }

    if (photoRows.length === 0 && deleteIds.length === 0) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }

    if (photoRows.length > 0) {
      // A stored object backs exactly ONE grid row. Two rows sharing an
      // object_path would break the delete contract — removing either row
      // drops the ledger row and the bytes, silently gutting the survivor.
      // Checked within the batch here, across the account by the ledger
      // check below plus the unique (patient_id, object_path) index.
      const batchPaths = new Set<string>();
      for (const row of photoRows) {
        if (batchPaths.has(row.object_path)) {
          res.status(400).json({ error: "Photo batch is invalid (duplicate photo objects)." });
          return;
        }
        batchPaths.add(row.object_path);
      }
      // Every grid row must point at an object the patient's media ledger
      // recorded at finalize: a path that skipped the rail (or whose upload
      // never finished) has no bytes worth listing — and later deleting.
      const ledger = await supabaseAdmin(
        "GET",
        `/rest/v1/patient_media?patient_id=eq.${auth.patientId}&kind=eq.progress&select=object_path`,
      );
      if (ledger.status >= 300) throw new Error(`photo ledger read failed (${ledger.status})`);
      const owned = new Set(
        (Array.isArray(ledger.json) ? (ledger.json as Array<Record<string, unknown>>) : []).map(
          row => String(row.object_path ?? ""),
        ),
      );
      for (const row of photoRows) {
        if (!owned.has(row.object_path)) {
          res
            .status(400)
            .json({ error: "A photo upload didn't finish. Retake it and try again." });
          return;
        }
      }
      const upsert = await supabaseAdmin(
        "POST",
        "/rest/v1/patient_progress_photos?on_conflict=patient_id,photo_id",
        photoRows,
        "resolution=merge-duplicates,return=minimal",
      );
      if (upsert.status === 409) {
        // Unique (patient_id, object_path) tripped: the object already
        // backs a DIFFERENT grid row (same-row updates merge fine above).
        res.status(400).json({ error: "Photo batch is invalid (photo object already in use)." });
        return;
      }
      if (upsert.status >= 300) throw new Error(`photo upsert failed (${upsert.status})`);
      // HQ Insights: one progress_photo event per saved photo.
      recordPatientEvent(auth.patientId, "progress_photo", { headers: req.headers, count: photoRows.length });
    }

    if (deleteIds.length > 0) {
      // Grid row + media-ledger row drop in ONE transaction; the function
      // hands back the object paths so the bytes can be deleted too. Rows
      // go first on purpose: if a byte delete fails the object is merely
      // orphaned (invisible, swept later) — the reverse order could leave
      // a grid row pointing at nothing.
      const removed = await supabaseAdmin("POST", "/rest/v1/rpc/patient_progress_photos_remove", {
        p_patient_id: auth.patientId,
        p_photo_ids: deleteIds,
      });
      if (removed.status >= 300) throw new Error(`photo remove failed (${removed.status})`);
      const paths = Array.isArray(removed.json)
        ? (removed.json as unknown[]).filter((p): p is string => typeof p === "string")
        : [];
      for (const objectPath of paths) {
        try {
          // The original AND its display variants go together.
          await deletePhotoWithVariants(objectPath);
        } catch (error) {
          req.log?.warn({ err: error, objectPath }, "progress photo byte delete failed");
        }
      }
    }

    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data photos write failed");
    res.status(502).json({ error: "Couldn't save your photos right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/flags", async (req, res) => {
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
    const idem = await openIdempotentWrite(req, res, auth.patientId, "flags");
    if (idem.handled) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { patient_id: auth.patientId };
    if (body.nudgeOptOut !== undefined) {
      if (typeof body.nudgeOptOut !== "boolean") {
        res.status(400).json({ error: "Nudge opt-out flag is invalid." });
        return;
      }
      row.nudge_opt_out = body.nudgeOptOut;
    }
    if (body.nudgeEngaged !== undefined) {
      if (typeof body.nudgeEngaged !== "boolean") {
        res.status(400).json({ error: "Nudge engagement flag is invalid." });
        return;
      }
      row.nudge_engaged = body.nudgeEngaged;
    }
    if (body.nudgeLastSentKey !== undefined) {
      if (body.nudgeLastSentKey !== null && !isDateKey(body.nudgeLastSentKey)) {
        res.status(400).json({ error: "Nudge sent date is invalid." });
        return;
      }
      row.nudge_last_sent_key = body.nudgeLastSentKey;
    }
    if (body.nudgeLastCrossingKey !== undefined) {
      if (body.nudgeLastCrossingKey !== null && !isDateKey(body.nudgeLastCrossingKey)) {
        res.status(400).json({ error: "Nudge crossing date is invalid." });
        return;
      }
      row.nudge_last_crossing_key = body.nudgeLastCrossingKey;
    }
    if (body.onboardingComplete !== undefined) {
      if (typeof body.onboardingComplete !== "boolean") {
        res.status(400).json({ error: "Onboarding completion flag is invalid." });
        return;
      }
      row.onboarding_complete = body.onboardingComplete;
    }
    if (body.onboardingAnswers !== undefined) {
      if (
        body.onboardingAnswers === null ||
        typeof body.onboardingAnswers !== "object" ||
        Array.isArray(body.onboardingAnswers) ||
        JSON.stringify(body.onboardingAnswers).length > 16 * 1024
      ) {
        res.status(400).json({ error: "Onboarding answers are invalid." });
        return;
      }
      row.onboarding_answers = stripOnboardingPassword(body.onboardingAnswers);
    }
    if (body.notificationPrefs !== undefined) {
      if (
        body.notificationPrefs === null ||
        typeof body.notificationPrefs !== "object" ||
        Array.isArray(body.notificationPrefs) ||
        JSON.stringify(body.notificationPrefs).length > 4 * 1024
      ) {
        res.status(400).json({ error: "Notification preferences are invalid." });
        return;
      }
      const prefsProblem = validateNotificationPrefsInput(body.notificationPrefs as Record<string, unknown>);
      if (prefsProblem) {
        res.status(400).json({ error: prefsProblem });
        return;
      }
      row.notification_prefs = body.notificationPrefs;
    }
    if (Object.keys(row).length === 1) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }
    row.updated_at = new Date().toISOString();
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_flags?on_conflict=patient_id",
      [row],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`flags upsert failed (${upsert.status})`);
    if (row.nudge_engaged === true) {
      // The patient answered the coach's outreach: close the loop on the
      // newest outreach notification so staff see "engaged" on the timeline.
      // Best-effort — the flag write above is the source of truth.
      try {
        await supabaseNotificationStore.markLatestEngaged(auth.patientId, OUTREACH_KIND, new Date());
      } catch (error) {
        req.log?.warn({ err: error }, "outreach engagement stamp failed");
      }
    }
    await idem.finish(res, 200, { ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data flags write failed");
    res.status(502).json({ error: "Couldn't save your settings right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
