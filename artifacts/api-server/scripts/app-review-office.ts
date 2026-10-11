/**
 * App Review office: the one office Apple and Google reviewers sign in to.
 *
 * Create the office and invite the reviewer patient through the normal HQ and
 * office screens (docs/store/reviewer-accounts.md), then run:
 *
 *   # Flag the office: app_review=true, HQ setup override on, access
 *   # complimentary for life in every configured Stripe mode.
 *   pnpm --filter @workspace/api-server exec tsx scripts/app-review-office.ts mark-office --office=<provider_id> --apply
 *
 *   # Put the reviewer patient back to the documented starting state:
 *   # onboarding complete, consent recorded, 14 days of sample diary,
 *   # water and check-in history. Refuses patients outside a review office.
 *   pnpm --filter @workspace/api-server exec tsx scripts/app-review-office.ts reset-patient --patient=<patient uuid> --apply
 *
 * Without --apply each command only reports what it would change.
 */
import { setIncludedPeriod } from "../src/billing/office-access/admin";
import { configuredModes } from "../src/billing/office-access/customer-identity";
import { SYSTEM_ACTOR } from "../src/billing/office-access/subscription";
import { runWithBillingIdentity } from "../src/billing/stripe-environment";
import { supabaseAdmin } from "../src/lib/supabase-admin";
import { CONSENT_POLICY_VERSION } from "../src/privacy/consent";

const [command, ...rest] = process.argv.slice(2);
const apply = rest.includes("--apply");
const arg = (name: string) => rest.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)?.trim() || null;
const enc = encodeURIComponent;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function must(method: string, path: string, body?: unknown, prefer?: string): Promise<unknown> {
  const res = await supabaseAdmin(method, path, body, prefer);
  if (res.status >= 300) fail(`${method} ${path} failed (${res.status}): ${JSON.stringify(res.json)}`);
  return res.json;
}

async function markOffice(): Promise<void> {
  const providerId = arg("office") ?? fail("--office=<provider_id> is required.");
  const rows = (await must(
    "GET",
    `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=provider_id,office_name,app_review,access_disabled,offboarding_status&limit=1`,
  )) as Array<Record<string, unknown>>;
  const office = rows[0] ?? fail(`No office ${providerId}.`);
  if (office.access_disabled === true || (office.offboarding_status ?? "active") !== "active") {
    fail("The App Review office must be an active office (not disabled or offboarding).");
  }
  const others = (await must(
    "GET",
    `/rest/v1/providers?app_review=is.true&provider_id=neq.${enc(providerId)}&select=provider_id&limit=5`,
  )) as Array<Record<string, unknown>>;
  if (others.length) fail(`Another office is already the App Review office: ${others.map((r) => r.provider_id).join(", ")}.`);

  const launch = ((await must(
    "GET",
    `/rest/v1/practice_launch?provider_id=eq.${enc(providerId)}&select=version,setup_override_at&limit=1`,
  )) as Array<Record<string, unknown>>)[0];
  const modes = configuredModes();

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${String(office.office_name)} (${providerId})`);
  console.log(`  app_review flag: ${office.app_review === true ? "already set" : "will set"}`);
  console.log(`  setup override: ${launch?.setup_override_at ? "already on" : launch ? "will enable" : "no practice_launch row (skipped)"}`);
  console.log(`  office access: complimentary for life in ${modes.length ? modes.map((m) => m.mode).join(", ") : "no configured Stripe mode"}`);
  if (!apply) return;

  if (office.app_review !== true) {
    await must("PATCH", `/rest/v1/providers?provider_id=eq.${enc(providerId)}`, { app_review: true }, "return=minimal");
  }
  if (launch && !launch.setup_override_at) {
    await must("POST", "/rest/v1/rpc/set_practice_launch_override", {
      p_provider_id: providerId,
      p_expected_version: launch.version,
      p_actor: null,
      p_enabled: true,
      p_note: "App Review office: store reviewers sign in here; not a customer.",
    });
  }
  for (const identity of modes) {
    await runWithBillingIdentity(identity, () =>
      setIncludedPeriod({ providerId, actor: SYSTEM_ACTOR, lifetime: true }),
    );
  }
  console.log("Done.");
}

/** Date key (YYYY-MM-DD, UTC) for `daysAgo` days before today. */
function dateKey(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

interface SampleFood { name: string; detail: string; calories: number; protein: number; carbs: number; fat: number }
const SAMPLE_MEALS: Record<"breakfast" | "lunch" | "dinner" | "snacks", SampleFood[]> = {
  breakfast: [
    { name: "Scrambled Eggs", detail: "2 large eggs", calories: 182, protein: 12, carbs: 2, fat: 14 },
    { name: "Greek Yogurt", detail: "1 cup, plain nonfat", calories: 130, protein: 22, carbs: 9, fat: 0 },
    { name: "Oatmeal", detail: "1 cup cooked", calories: 158, protein: 6, carbs: 27, fat: 3 },
  ],
  lunch: [
    { name: "Grilled Chicken Salad", detail: "6 oz chicken, mixed greens", calories: 380, protein: 42, carbs: 12, fat: 18 },
    { name: "Turkey Lettuce Wraps", detail: "4 oz turkey", calories: 240, protein: 30, carbs: 8, fat: 9 },
    { name: "Tuna Salad", detail: "1 can, light mayo", calories: 290, protein: 33, carbs: 4, fat: 15 },
  ],
  dinner: [
    { name: "Baked Salmon", detail: "6 oz with asparagus", calories: 420, protein: 40, carbs: 8, fat: 24 },
    { name: "Sirloin Steak", detail: "5 oz with broccoli", calories: 390, protein: 44, carbs: 10, fat: 18 },
    { name: "Shrimp Stir-Fry", detail: "6 oz shrimp, vegetables", calories: 330, protein: 36, carbs: 14, fat: 12 },
  ],
  snacks: [
    { name: "Almonds", detail: "1 oz", calories: 164, protein: 6, carbs: 6, fat: 14 },
    { name: "Apple", detail: "1 medium", calories: 95, protein: 0, carbs: 25, fat: 0 },
    { name: "String Cheese", detail: "1 stick", calories: 80, protein: 7, carbs: 1, fat: 6 },
  ],
};
const SAMPLE_DAYS = 14;
const START_WEIGHT_LB = 212.4;

const RESET_TABLES = [
  "patient_diary_entries",
  "patient_water_days",
  "patient_check_ins",
  "patient_food_prefs",
  "patient_target_overrides",
] as const;

async function resetPatient(): Promise<void> {
  const patientId = arg("patient") ?? fail("--patient=<patient uuid> is required.");
  const rows = (await must(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&select=id,name,provider_id,activation_status,auth_user_id,archived_at,closed_at&limit=1`,
  )) as Array<Record<string, unknown>>;
  const patient = rows[0] ?? fail(`No patient ${patientId}.`);
  const office = ((await must(
    "GET",
    `/rest/v1/providers?provider_id=eq.${enc(String(patient.provider_id))}&select=provider_id,office_name,app_review&limit=1`,
  )) as Array<Record<string, unknown>>)[0];
  // The only guard that matters: this script must never touch a real patient.
  if (office?.app_review !== true) fail(`Patient ${patientId} belongs to ${String(office?.office_name ?? "an unknown office")}, which is not the App Review office. Refusing.`);
  if (patient.archived_at || patient.closed_at) fail("The reviewer patient is archived or closed; re-enroll a fresh reviewer patient instead.");
  if (patient.activation_status !== "activated" || !patient.auth_user_id) {
    fail("The reviewer patient has not finished enrollment yet (Create New Account → I have an invitation, then set a password).");
  }

  const entries: Array<Record<string, unknown>> = [];
  const water: Array<Record<string, unknown>> = [];
  const checkIns: Array<Record<string, unknown>> = [];
  for (let daysAgo = SAMPLE_DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
    const key = dateKey(daysAgo);
    const pick = (SAMPLE_DAYS - 1 - daysAgo) % 3;
    for (const meal of ["breakfast", "lunch", "dinner", "snacks"] as const) {
      // Today is deliberately half-logged so the reviewer has something to add.
      if (daysAgo === 0 && (meal === "dinner" || meal === "snacks")) continue;
      const food = SAMPLE_MEALS[meal][pick];
      entries.push({
        patient_id: patientId,
        entry_id: `review_${key}_${meal}`,
        date_key: key,
        meal,
        kind: "quick",
        ref_id: null,
        name: food.name,
        detail: food.detail,
        quantity: 1,
        calories: food.calories,
        protein: food.protein,
        carbs: food.carbs,
        fat: food.fat,
      });
    }
    water.push({ patient_id: patientId, date_key: key, oz: daysAgo === 0 ? 24 : 56 + (pick * 8) });
    if (daysAgo % 7 === 6 || daysAgo === 0) {
      const weeks = Math.floor((SAMPLE_DAYS - 1 - daysAgo) / 7);
      checkIns.push({
        patient_id: patientId,
        date_key: key,
        check_in_id: `review_ci_${key}`,
        weight: Math.round((START_WEIGHT_LB - weeks * 2.3 - (daysAgo === 0 ? 0.6 : 0)) * 10) / 10,
        mood: 4,
        side_effects: [],
        notes: null,
      });
    }
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} — reviewer patient ${String(patient.name)} (${patientId}) in ${String(office.office_name)}`);
  console.log(`  clear: ${RESET_TABLES.join(", ")}`);
  console.log(`  seed: ${entries.length} diary entries, ${water.length} water days, ${checkIns.length} check-ins over ${SAMPLE_DAYS} days`);
  console.log(`  flags: onboarding_complete=true, nudge state cleared; consent ${CONSENT_POLICY_VERSION} recorded`);
  if (!apply) return;

  for (const table of RESET_TABLES) {
    await must("DELETE", `/rest/v1/${table}?patient_id=eq.${enc(patientId)}`, undefined, "return=minimal");
  }
  await must("POST", "/rest/v1/patient_diary_entries", entries, "return=minimal");
  await must("POST", "/rest/v1/patient_water_days", water, "return=minimal");
  await must("POST", "/rest/v1/patient_check_ins", checkIns, "return=minimal");
  await must(
    "POST",
    "/rest/v1/patient_flags?on_conflict=patient_id",
    {
      patient_id: patientId,
      onboarding_complete: true,
      nudge_opt_out: false,
      nudge_engaged: false,
      nudge_last_sent_key: null,
      nudge_last_crossing_key: null,
      updated_at: new Date().toISOString(),
    },
    "resolution=merge-duplicates,return=minimal",
  );
  await must(
    "POST",
    "/rest/v1/patient_consents?on_conflict=patient_id,policy_version",
    {
      patient_id: patientId,
      policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true,
      privacy_accepted: true,
      health_data_accepted: true,
      photo_analysis_accepted: true,
      app_version: null,
      platform: null,
      recorded_at: new Date().toISOString(),
    },
    "resolution=merge-duplicates,return=minimal",
  );
  console.log("Done. Sign out and back in on the device to see the refreshed history.");
}

if (command === "mark-office") await markOffice();
else if (command === "reset-patient") await resetPatient();
else fail("Usage: app-review-office.ts <mark-office --office=ID | reset-patient --patient=UUID> [--apply]");
