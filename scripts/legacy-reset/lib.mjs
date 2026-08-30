/**
 * Shared helpers for the one-time legacy archive + reset (task: archive all
 * old data, then start the database fresh).
 *
 * There is no direct Postgres socket in this workspace, so every SQL
 * statement goes through the Supabase management API
 * (POST /v1/projects/{ref}/database/query — multi-statement bodies run in one
 * transaction). GoTrue admin calls go through {SUPABASE_URL}/auth/v1/admin.
 *
 * Nothing here ever prints secret values; env vars are read and forwarded as
 * headers only.
 */

export function projectRef() {
  const url = process.env.SUPABASE_URL || "";
  const match = url.match(/^https:\/\/([^.]+)\./);
  if (!match) throw new Error("SUPABASE_URL is not configured");
  return match[1];
}

function accessToken() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not configured");
  return token;
}

export function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return key;
}

export function supabaseBase() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

/** Run SQL through the management API. Throws on any non-2xx response. */
export async function sql(query, { label = "" } = {}) {
  const started = Date.now();
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef()}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!response.ok) {
    throw new Error(
      `SQL ${label || "query"} failed (${response.status}, ${elapsed}s): ${text.slice(0, 800)}`,
    );
  }
  if (label) console.log(`  ok: ${label} (${elapsed}s)`);
  return json;
}

/** GoTrue / PostgREST admin request with the service-role key. */
export async function adminFetch(method, path, body) {
  const response = await fetch(`${supabaseBase()}${path}`, {
    method,
    headers: {
      apikey: serviceKey(),
      Authorization: `Bearer ${serviceKey()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

/** The fixed identities this reset preserves / removes. */
export const OWNER_AUTH_ID = "de64a560-48b2-410a-bb76-954514f7e2ac";
export const OWNER_EMAIL = "andrew+admin@thinnrweightloss.com";
export const STALE_ROLE_ASSIGNMENT_EMAIL = "andrew+provider@thinnrweightloss.com";
export const TEST_STAFF_EMAILS = [
  "dana.frontdesk@jenkinswellness.example.com",
  "qa-ui-staff-c0ptwv@thinnr-staff-check.com",
];
/** Dangling pre-approval with no auth user; removed alongside the test staff. */
export const TEST_STAFF_ASSIGNMENT_ONLY_EMAILS = [
  "riley-test@jenkinswellness.example.com",
];

/** Every public table, split by what the reset does to it. */
export const WIPE_TABLES = [
  // deleted children-first relative to patients/providers/product_subscriptions
  "transactions",
  "product_subscriptions",
  "app_subscriptions",
  "chatbot_messages",
  "coach_conversation_messages",
  "coach_conversations",
  "patient_messages",
  "patient_logs",
  "patient_log_flags",
  "patient_feedback",
  "patient_measurements",
  "custom_foods",
  "custom_recipes",
  "customers",
  "training_completions",
  "training_invites",
  "training_learner_sessions",
  "training_viewers",
  "claim_verifications",
  "user_metrics",
  "users_onboarded_daily",
  "global_onboard_daily",
  "patients",
  "provider_measurements",
  "provider_referrals",
  "team_members",
  "providers",
];

/** Kept in full — reference/content and empty feature tables. */
export const KEEP_TABLES = [
  "approved_foods",
  "barcode_nutrition_facts",
  "craving_foods",
  "craving_foods_flagged",
  "hq_invitations",
  "hq_memberships",
  "ingredient_macros",
  "knowledge_documents",
  "possible_free_foods",
  "provider_account_locks",
  "tech_support_messages",
  "training_courses",
  "training_media_cleanup",
  "training_modules",
  "training_subgroups",
  "training_video_transcripts",
  "training_videos",
];

/** Owner row survives; every other row goes. */
export const PARTIAL_TABLES = ["profiles", "staff_role_assignments", "role_assignments"];

export const ALL_PUBLIC_TABLES = [...WIPE_TABLES, ...KEEP_TABLES, ...PARTIAL_TABLES].sort();

/** Kept-table row counts pinned at classification time (2026-08-30). */
export const KEEP_COUNTS = {
  approved_foods: 129677,
  barcode_nutrition_facts: 7,
  craving_foods: 13001,
  craving_foods_flagged: 238,
  hq_invitations: 0,
  hq_memberships: 1,
  ingredient_macros: 68738,
  knowledge_documents: 5,
  possible_free_foods: 4811,
  provider_account_locks: 0,
  tech_support_messages: 0,
  training_courses: 3,
  training_media_cleanup: 0,
  training_modules: 10,
  training_subgroups: 3,
  training_video_transcripts: 0,
  training_videos: 48,
};
