#!/usr/bin/env node
/**
 * One disposable, live Coach browser fixture.
 *
 * This deliberately creates real throwaway identities and real GoTrue
 * sessions.  The sessions are placed only in private, short-lived helper
 * files; setup output contains fixture IDs and helper URLs, never a password,
 * token, email address, or transcript.
 *
 * Run only after both Coach migrations have been applied:
 *   node scripts/coach-browser-fixture.mjs setup --allow-live-fixtures
 *   node scripts/coach-browser-fixture.mjs cleanup --allow-live-fixtures
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
if (!["setup", "cleanup", "patient-mobile-helper", "provider-mobile-helper"].includes(command) || !process.argv.includes("--allow-live-fixtures")) {
  console.error("Usage: node scripts/coach-browser-fixture.mjs setup|cleanup|patient-mobile-helper|provider-mobile-helper --allow-live-fixtures");
  process.exit(2);
}

assert(process.env.NODE_ENV !== "production", "Refusing fixtures in a production process");
const required = (name) => {
  assert(process.env[name]?.trim(), `${name} must be configured in workspace secrets`);
  return process.env[name].trim();
};

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const managementToken = required("SUPABASE_ACCESS_TOKEN");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const devDomain = required("REPLIT_DEV_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const expoDevDomain = required("REPLIT_EXPO_DEV_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
const cacheDir = fileURLToPath(new URL("../.cache/coach-browser-fixture/", import.meta.url));
const statePath = `${cacheDir}/state.json`;
const OPS_PUBLIC = fileURLToPath(new URL("../artifacts/thinnr-operations/public/", import.meta.url));
const MOBILE_PUBLIC = fileURLToPath(new URL("../artifacts/thinnr-mobile/public/", import.meta.url));
// Expo development serves public/, while the standalone Expo server serves
// static-build/ directly and its build script does not copy public/ assets.
const MOBILE_STATIC = fileURLToPath(new URL("../artifacts/thinnr-mobile/static-build/", import.meta.url));

const sqlString = (value) => value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const jsonSql = (value) => `${sqlString(JSON.stringify(value))}::jsonb`;
const fixtureUrlRoot = `https://${devDomain}`;
const fixtureExpoUrlRoot = `https://${expoDevDomain}`;

function sanitizedSqlFailure(body) {
  const record = body && typeof body === "object" ? body : null;
  const nested = record?.error && typeof record.error === "object" ? record.error : null;
  const codeValue = record?.code ?? nested?.code;
  const messageValue = record?.message ?? nested?.message ?? (typeof record?.error === "string" ? record.error : null);
  const code = typeof codeValue === "string" && /^[A-Z0-9]{5}$/i.test(codeValue) ? codeValue : null;
  const message = typeof messageValue === "string" ? messageValue.trim() : null;
  // Database error details may interpolate a fixture row. Only show a compact,
  // punctuation-restricted schema error; never interpolate an arbitrary value.
  const safeMessage = message && message.length <= 180 &&
    (
      /^(?:ERROR:\s*)?(?:column|relation|function|schema) "[A-Za-z0-9_.(), ]+" (?:does not exist|already exists)$/i.test(message) ||
      /^(?:ERROR:\s*)?null value in column "[A-Za-z0-9_]+" violates not-null constraint$/i.test(message) ||
      /^(?:ERROR:\s*)?duplicate key value violates unique constraint "[A-Za-z0-9_]+"$/i.test(message) ||
      /^(?:ERROR:\s*)?invalid input syntax for type [A-Za-z0-9_ ]+$/i.test(message)
    )
    ? message
    : null;
  return [code, safeMessage].filter(Boolean).join(": ");
}

async function sql(query, label = "fixture SQL") {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = sanitizedSqlFailure(await response.json().catch(() => null));
    throw new Error(`${label} failed (${response.status}${detail ? `; ${detail}` : ""}); recovery manifest retained`);
  }
  return response.json();
}

async function authAdmin(method, path, body) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Fixture auth operation failed (${response.status}); recovery manifest retained`);
  return response.status === 204 ? null : response.json();
}

function privateJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

async function save(state, exclusive = false) {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: exclusive ? "wx" : "w" });
}

function validateState(state) {
  const optionalUuid = (value, label) => {
    assert(value == null || /^[0-9a-f-]{36}$/i.test(value), `${label} is not a fixture UUID`);
  };
  assert.match(state.run, /^[0-9a-f-]{36}$/i);
  assert.equal(state.projectRef, projectRef, "Supabase project changed; refusing cross-project cleanup");
  assert.equal(state.providerId, `coach-browser-${state.run}`);
  assert.equal(state.ownerEmail, `coach-owner-${state.run}@fixture.example.com`);
  assert.equal(state.patientEmail, `coach-patient-${state.run}@fixture.example.com`);
  assert.equal(state.patientId, state.run);
  optionalUuid(state.ownerId, "ownerId");
  optionalUuid(state.patientUserId, "patientUserId");
  optionalUuid(state.sourceConversationId, "sourceConversationId");
  optionalUuid(state.legacyConversationId, "legacyConversationId");
  assert.equal(state.helperFiles?.opsPublic, `${OPS_PUBLIC}coach-browser-${state.run}.html`);
  assert.equal(state.helperFiles?.mobilePublic, `${MOBILE_PUBLIC}coach-browser-${state.run}.html`);
  assert.equal(state.helperFiles?.mobileStatic, `${MOBILE_STATIC}coach-browser-${state.run}.html`);
  const providerName = `coach-browser-${state.run}-provider.html`;
  assert(
    state.helperFiles?.providerMobilePublic === undefined ||
      state.helperFiles.providerMobilePublic === `${MOBILE_PUBLIC}${providerName}`,
    "provider mobile helper has an unexpected path",
  );
  assert(
    state.helperFiles?.providerMobileStatic === undefined ||
      state.helperFiles.providerMobileStatic === `${MOBILE_STATIC}${providerName}`,
    "provider mobile helper has an unexpected path",
  );
}

async function requireCoachMigrations() {
  const [row] = await sql(`
    select
      to_regclass('public.patient_chat_conversations') is not null as conversations,
      to_regclass('public.patient_chat_messages') is not null as messages,
      to_regclass('public.coach_conversation_work') is not null as work,
      to_regclass('public.coach_memories') is not null as memories,
      exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='coach_memories' and column_name='source_message_id'
        and is_nullable='NO') as memory_source_message_id,
      exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='coach_memories' and column_name='source_text_hash'
        and is_nullable='NO') as memory_source_text_hash,
      exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='patient_chat_conversations' and column_name='client_key') as separate_coach_conversations,
      to_regprocedure('public.coach_conversation_create(uuid,text)') is not null as create_fn,
      to_regprocedure('public.coach_conversation_append(uuid,uuid,jsonb)') is not null as append_fn,
      to_regprocedure('public.coach_legacy_conversation_id(uuid)') is not null as legacy_fn,
      to_regprocedure('public.patient_apply_profile_setup(uuid,uuid,jsonb,jsonb,jsonb,boolean)') is not null as onboarding_fn,
      to_regprocedure('public.provision_staff_login(uuid,text,text,text)') is not null as staff_fn
  `, "Coach migration contract check");
  assert(
    row?.conversations && row?.messages && row?.work && row?.memories &&
      row?.memory_source_message_id && row?.memory_source_text_hash &&
      row?.separate_coach_conversations && row?.create_fn && row?.append_fn &&
      row?.legacy_fn && row?.onboarding_fn && row?.staff_fn,
    "Coach migrations are not fully applied; no fixture was created",
  );
}

async function passwordSession(email, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Fixture session mint failed (${response.status}); recovery manifest retained`);
  const payload = await response.json();
  assert(
    typeof payload?.access_token === "string" &&
      typeof payload?.refresh_token === "string" &&
      payload?.user?.id,
    "Fixture session mint returned an invalid response",
  );
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "bearer",
    expires_in: Number(payload.expires_in),
    expires_at: Number.isFinite(Number(payload.expires_at))
      ? Number(payload.expires_at)
      : Math.floor(Date.now() / 1_000) + Number(payload.expires_in),
    user: payload.user,
  };
}

async function authenticatedRest(accessToken, path) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Authenticated fixture verification failed (${response.status}); recovery manifest retained`);
  return response.json();
}

function helperHtml({ session, signInId, deviceId, destination, operations, appMode = null }) {
  const storageKey = `sb-${projectRef}-auth-token`;
  const payload = privateJson({
    session, signInId, deviceId, destination, storageKey, operations, appMode,
    apiBase: fixtureUrlRoot,
  });
  return `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Preparing isolated test session</title>
<p id="status">Preparing isolated test session…</p>
<script>
(() => {
  const fixture = ${payload};
  try {
    localStorage.setItem(fixture.storageKey, JSON.stringify(fixture.session));
    if (fixture.operations) {
      localStorage.setItem("thinnr.device-id", fixture.deviceId);
      localStorage.setItem("thinnr-ops-code-login-at", String(Date.now()));
    } else {
      // AsyncStorage on Expo web is localStorage; this is the exact device
      // identifier that mobile's auth API stamps into x-thinnr-device.
      localStorage.setItem("thinnr_push_install_id_v1", fixture.deviceId);
    }
    if (fixture.appMode === "staff" || fixture.appMode === "patient") {
      localStorage.setItem("thinnr_app_mode_v1", fixture.appMode);
    }
  } catch {
    document.querySelector("#status").textContent = "Browser storage is unavailable.";
    return;
  }
  // This uses the same one-time sign-in ledger attachment that the real apps
  // make after Supabase owns the session. It deliberately exposes no response.
  fetch(fixture.apiBase + "/api/security/me/attach", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + fixture.session.access_token,
      "x-thinnr-device": fixture.deviceId,
      "x-thinnr-platform": "web"
    },
    body: JSON.stringify({ signInId: fixture.signInId }),
    cache: "no-store"
  }).catch(() => undefined).finally(() => location.replace(fixture.destination));
})();
</script>`;
}

async function writeHelpers(state, sessions) {
  const tempDir = `/tmp/coach-browser-fixture-${state.run}`;
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const opsName = `coach-browser-${state.run}.html`;
  const opsTemp = `${tempDir}/operations-session.html`;
  const opsDestination = `${fixtureUrlRoot}/`;
  await writeFile(
    opsTemp,
    helperHtml({
      session: sessions.owner,
      signInId: state.ownerSignInId,
      deviceId: state.ownerDeviceId,
      destination: opsDestination,
      operations: true,
    }),
    { mode: 0o600 },
  );
  await copyFile(opsTemp, `${OPS_PUBLIC}${opsName}`, 0);
  state.helperFiles = {
    tempDir,
    opsTemp,
    opsPublic: `${OPS_PUBLIC}${opsName}`,
  };
  state.helperUrls = {
    operations: `${fixtureUrlRoot}/${opsName}`,
  };
  await save(state);
  await writePatientMobileHelper(state, sessions.patient);
  await writeProviderMobileHelper(state, sessions.owner);
}

async function writePatientMobileHelper(state, patientSession) {
  const tempDir = state.helperFiles?.tempDir ?? `/tmp/coach-browser-fixture-${state.run}`;
  const mobileName = `coach-browser-${state.run}.html`;
  const mobileTemp = `${tempDir}/mobile-session.html`;
  const mobilePublic = `${MOBILE_PUBLIC}${mobileName}`;
  const mobileStatic = `${MOBILE_STATIC}${mobileName}`;
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  await mkdir(MOBILE_STATIC, { recursive: true, mode: 0o700 });
  await writeFile(
    mobileTemp,
    helperHtml({
      session: patientSession,
      signInId: state.patientSignInId,
      deviceId: state.patientDeviceId,
      destination: `${fixtureExpoUrlRoot}/`,
      operations: false,
      // The mobile tab layout uses persisted persona before the account
      // resolver completes. A real patient session without this value is
      // redirected to the signed-out welcome screen during that first render.
      appMode: "patient",
    }),
    { mode: 0o600 },
  );
  await copyFile(mobileTemp, mobilePublic, 0);
  // The extra ignored copy is required only by server/serve.js exports. It is
  // the same short-lived helper, removed by cleanup along with public/ copies.
  await copyFile(mobileTemp, mobileStatic, 0);
  state.helperFiles = {
    ...(state.helperFiles ?? {}),
    mobileTemp,
    mobilePublic,
    mobileStatic,
  };
  state.helperUrls = {
    ...(state.helperUrls ?? {}),
    patient: `${fixtureExpoUrlRoot}/${mobileName}`,
  };
  await save(state);
}

async function writeProviderMobileHelper(state, ownerSession) {
  const tempDir = state.helperFiles?.tempDir ?? `/tmp/coach-browser-fixture-${state.run}`;
  const providerName = `coach-browser-${state.run}-provider.html`;
  const providerTemp = `${tempDir}/provider-mobile-session.html`;
  const providerPublic = `${MOBILE_PUBLIC}${providerName}`;
  const providerStatic = `${MOBILE_STATIC}${providerName}`;
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  await mkdir(MOBILE_STATIC, { recursive: true, mode: 0o700 });
  await writeFile(
    providerTemp,
    helperHtml({
      session: ownerSession,
      signInId: state.ownerSignInId,
      deviceId: state.ownerDeviceId,
      destination: `${fixtureExpoUrlRoot}/office-patient/${encodeURIComponent(state.patientId)}`,
      operations: false,
      appMode: "staff",
    }),
    { mode: 0o600 },
  );
  await copyFile(providerTemp, providerPublic, 0);
  await copyFile(providerTemp, providerStatic, 0);
  state.helperFiles = {
    ...(state.helperFiles ?? {}),
    providerMobileTemp: providerTemp,
    providerMobilePublic: providerPublic,
    providerMobileStatic: providerStatic,
  };
  state.helperUrls = {
    ...(state.helperUrls ?? {}),
    providerMobile: `${fixtureExpoUrlRoot}/${providerName}`,
  };
  await save(state);
}

async function existingHelperSession(path) {
  const html = await readFile(path, "utf8");
  const match = html.match(/const fixture = (.+);\n  try \{/);
  assert(match, "Owner helper session payload is unavailable");
  const session = JSON.parse(match[1])?.session;
  assert(typeof session?.access_token === "string" && typeof session?.refresh_token === "string",
    "Owner helper does not contain a reusable fixture session");
  return session;
}

async function patientHelperSession(path) {
  const html = await readFile(path, "utf8");
  const match = html.match(/const fixture = (.+);\n  try \{/);
  assert(match, "Patient helper session payload is unavailable");
  const session = JSON.parse(match[1])?.session;
  assert(typeof session?.access_token === "string" && typeof session?.refresh_token === "string",
    "Patient helper does not contain a reusable fixture session");
  return session;
}

async function setup() {
  await requireCoachMigrations();
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const run = randomUUID();
  const phoneSuffix = String(randomInt(0, 100)).padStart(4, "0");
  const state = {
    run,
    projectRef,
    providerId: `coach-browser-${run}`,
    patientId: run,
    ownerEmail: `coach-owner-${run}@fixture.example.com`,
    patientEmail: `coach-patient-${run}@fixture.example.com`,
    patientPhone: `+1555010${phoneSuffix}`,
    ownerId: null,
    patientUserId: null,
    sourceConversationId: null,
    legacyConversationId: null,
    ownerSignInId: randomUUID(),
    patientSignInId: randomUUID(),
    ownerDeviceId: `coach-ops-${randomBytes(16).toString("hex")}`,
    patientDeviceId: `coach-mobile-${randomBytes(16).toString("hex")}`,
    helperFiles: {
      opsPublic: `${OPS_PUBLIC}coach-browser-${run}.html`,
      mobilePublic: `${MOBILE_PUBLIC}coach-browser-${run}.html`,
      mobileStatic: `${MOBILE_STATIC}coach-browser-${run}.html`,
      providerMobilePublic: `${MOBILE_PUBLIC}coach-browser-${run}-provider.html`,
      providerMobileStatic: `${MOBILE_STATIC}coach-browser-${run}-provider.html`,
    },
  };
  // Save before the first mutation. A partial run can always be cleaned by its
  // exact synthetic identifiers, but setup refuses overlapping fixtures.
  await save(state, true);

  const ownerPassword = randomBytes(40).toString("base64url");
  const patientPassword = randomBytes(40).toString("base64url");
  const owner = await authAdmin("POST", "users", {
    email: state.ownerEmail,
    email_confirm: true,
    password: ownerPassword,
    user_metadata: { display_name: "Coach Browser Office Owner" },
    app_metadata: { thinnr_claim: "provider", thinnr_claim_ref: state.providerId },
  });
  state.ownerId = owner?.id ?? owner?.user?.id ?? null;
  assert.match(state.ownerId ?? "", /^[0-9a-f-]{36}$/i);
  await save(state);

  const patientUser = await authAdmin("POST", "users", {
    email: state.patientEmail,
    email_confirm: true,
    password: patientPassword,
    user_metadata: { display_name: "Coach Browser Patient" },
    app_metadata: { thinnr_claim: "patient", thinnr_claim_ref: state.patientId },
  });
  state.patientUserId = patientUser?.id ?? patientUser?.user?.id ?? null;
  assert.match(state.patientUserId ?? "", /^[0-9a-f-]{36}$/i);
  await save(state);

  const sourceKey = `fixture-source-${run}`;
  const sourceMessages = [];
  // 256 rows exercises the newest-100 page, an older `before` page, and the
  // remaining final page without touching a real patient's transcript.
  for (let turn = 1; turn <= 128; turn += 1) {
    const index = String(turn).padStart(2, "0");
    const text = turn === 1
      ? "I prefer vegetarian meals."
      : turn === 2
        ? "I have a peanut allergy."
        : `Fixture coach source question ${index}.`;
    sourceMessages.push({ client_id: `fixture-user-${index}`, role: "user", text });
    sourceMessages.push({
      client_id: `fixture-assistant-${index}`,
      role: "assistant",
      text: `Fixture coach source reply ${index}.`,
      reply_to_client_id: `fixture-user-${index}`,
    });
  }

  // The profile setup and consent are the same canonical database rails used
  // by the product. Notifications are explicitly off; no delivery endpoint is
  // invoked by this fixture.
  await sql(`
    begin;
    insert into public.providers
      (provider_id, provider_name, office_name, email, onboarding_code, access_disabled, auth_user_id, claimed_at)
    values (
      ${sqlString(state.providerId)}, 'Coach Browser Owner', 'Coach Browser Office',
      ${sqlString(state.ownerEmail)}, ${sqlString(String(randomInt(100000, 1000000)))}, false,
      ${sqlString(state.ownerId)}::uuid, now()
    );
    insert into public.patients
      (id, provider_id, auth_user_id, claimed_at, activation_status, name, first_name, last_name,
       email, phone, date_of_birth, height_inches, gender, height_unit, starting_weight,
       current_weight, goal_weight, timezone, program_id, program_start_date,
       created_at, email_verified_at, phone_verified_at, deletion_requested_at)
    values (
      ${sqlString(state.patientId)}::uuid, ${sqlString(state.providerId)}, ${sqlString(state.patientUserId)}::uuid,
      now(), 'activated', 'Coach Browser Patient', 'Coach', 'Patient',
      ${sqlString(state.patientEmail)}, ${sqlString(state.patientPhone)}, date '1988-01-01',
      66, 'female', 'imperial', 210, 205, 170, 'America/Chicago', 'thinnr', current_date - 14,
      now(), now(), now(), null
    );
    select public.patient_apply_profile_setup(
      ${sqlString(state.patientId)}::uuid, ${sqlString(state.patientUserId)}::uuid,
      ${jsonSql({
        first_name: "Coach", last_name: "Patient", name: "Coach Browser Patient",
        date_of_birth: "1988-01-01", gender: "female", height_inches: 66,
        height_unit: "imperial", starting_weight: 210, current_weight: 205,
        goal_weight: 170, timezone: "America/Chicago", program_id: "thinnr",
        program_start_date: new Date().toISOString().slice(0, 10),
      })},
      ${jsonSql({ goal: "wellness", dietaryPattern: "vegetarian" })},
      ${jsonSql({ push: false, email: false, sms: false })}, true
    );
    insert into public.patient_consents
      (patient_id, policy_version, terms_accepted, privacy_accepted, health_data_accepted,
       photo_analysis_accepted, app_version, platform)
    values (${sqlString(state.patientId)}::uuid, '2026-09-01', true, true, true, false, 'coach-browser-fixture', 'web');
    select public.provision_staff_login(
      ${sqlString(state.ownerId)}::uuid, ${sqlString(state.ownerEmail)},
      'Coach Browser Office Owner', ${sqlString(state.providerId)}
    );
    commit;
  `, "fixture account provisioning");

  const created = await sql(`
    select id from public.coach_conversation_create(
      ${sqlString(state.patientId)}::uuid, ${sqlString(sourceKey)}
    )
  `, "fixture source conversation creation");
  state.sourceConversationId = created?.[0]?.id ?? null;
  assert.match(state.sourceConversationId ?? "", /^[0-9a-f-]{36}$/i);
  await save(state);

  await sql(`
    select public.coach_conversation_append(
      ${sqlString(state.patientId)}::uuid, ${sqlString(state.sourceConversationId)}::uuid, ${jsonSql(sourceMessages)}
    );
    select public.patient_chat_apply(
      ${sqlString(state.patientId)}::uuid, 'coach',
      ${jsonSql([{ client_id: "fixture-legacy-user", role: "user", text: "Fixture legacy Coach message." }])}
    );
  `, "fixture conversation append");
  const [legacy] = await sql(`
    select public.coach_legacy_conversation_id(${sqlString(state.patientId)}::uuid) as id
  `, "fixture legacy conversation lookup");
  state.legacyConversationId = legacy?.id ?? null;
  assert.match(state.legacyConversationId ?? "", /^[0-9a-f-]{36}$/i);
  await save(state);

  // These records are intentionally inserted from their already-persisted
  // source messages. They mirror the canonical extractor's states without
  // claiming the shared production worker queue (which could claim another
  // patient's pending work).
  await sql(`
    begin;
    insert into public.coach_memories
      (patient_id, text, category, sensitivity, state, source_conversation_id,
       source_message_id, source_created_at, topic_key, source_text_hash, confirmed_at)
    select ${sqlString(state.patientId)}::uuid, 'I prefer vegetarian meals.', 'food_preference',
      'ordinary', 'active', ${sqlString(state.sourceConversationId)}::uuid, 'fixture-user-01',
      m.created_at, private.coach_memory_topic_key(m.text), private.coach_memory_topic_key(m.text), now()
    from public.patient_chat_messages m
    where m.conversation_id=${sqlString(state.sourceConversationId)}::uuid and m.client_id='fixture-user-01';
    insert into public.coach_memories
      (patient_id, text, category, sensitivity, state, source_conversation_id,
       source_message_id, source_created_at, topic_key, source_text_hash, confirmed_at)
    select ${sqlString(state.patientId)}::uuid, 'I have a peanut allergy.', 'patient_detail',
      'sensitive', 'pending', ${sqlString(state.sourceConversationId)}::uuid, 'fixture-user-02',
      m.created_at, private.coach_memory_topic_key(m.text), private.coach_memory_topic_key(m.text), null
    from public.patient_chat_messages m
    where m.conversation_id=${sqlString(state.sourceConversationId)}::uuid and m.client_id='fixture-user-02';
    update public.coach_conversation_work set state='ready', updated_at=now(), last_error=null
    where patient_id=${sqlString(state.patientId)}::uuid;
    update public.patient_chat_conversations
    set title='Fixture source conversation', title_state='ready', processing_state='ready'
    where id=${sqlString(state.sourceConversationId)}::uuid;
    commit;
  `, "fixture memory seed");

  const [ownerSession, patientSession] = await Promise.all([
    passwordSession(state.ownerEmail, ownerPassword),
    passwordSession(state.patientEmail, patientPassword),
  ]);

  // Verify both sides as authenticated users. This catches the historical
  // "claimed row but unadmitted workspace" failure before a browser receives a
  // helper, without starting a passwordless email/SMS flow.
  const [ownerProfile, ownerProvider, patientRecord] = await Promise.all([
    authenticatedRest(ownerSession.access_token, `profiles?id=eq.${encodeURIComponent(state.ownerId)}&select=role,provider_account_code&limit=1`),
    authenticatedRest(ownerSession.access_token, `providers?provider_id=eq.${encodeURIComponent(state.providerId)}&select=provider_id,auth_user_id&limit=1`),
    authenticatedRest(patientSession.access_token, `patients?id=eq.${encodeURIComponent(state.patientId)}&select=id,auth_user_id,claimed_at,activation_status,deletion_requested_at&limit=1`),
  ]);
  assert.equal(ownerProfile?.[0]?.role, "provider_staff", "Owner workspace profile was not admitted");
  assert.equal(ownerProfile?.[0]?.provider_account_code, state.providerId, "Owner profile resolved to the wrong workspace");
  assert.equal(ownerProvider?.[0]?.auth_user_id, state.ownerId, "Owner account resolution did not map to its office");
  assert.equal(patientRecord?.[0]?.auth_user_id, state.patientUserId, "Patient account is not claimed");
  assert.equal(patientRecord?.[0]?.activation_status, "activated", "Patient account is not activated");
  assert.equal(patientRecord?.[0]?.deletion_requested_at, null, "Patient deletion flag is unexpectedly set");

  const [verified] = await sql(`
    insert into public.auth_sign_ins
      (id, user_id, realm, method, platform, device_fingerprint, device_label)
    values
      (${sqlString(state.ownerSignInId)}::uuid, ${sqlString(state.ownerId)}::uuid, 'staff', 'email_code', 'web',
       ${sqlString(createHash("sha256").update(`device:${state.ownerDeviceId}`).digest("hex").slice(0, 40))}, 'Coach browser operations'),
      (${sqlString(state.patientSignInId)}::uuid, ${sqlString(state.patientUserId)}::uuid, 'patient', 'password_email_code', 'web',
       ${sqlString(createHash("sha256").update(`device:${state.patientDeviceId}`).digest("hex").slice(0, 40))}, 'Coach browser mobile')
    returning id
  `, "fixture sign-in ledger");
  assert(verified?.id, "Fixture sign-in ledger could not be created");
  await writeHelpers(state, { owner: ownerSession, patient: patientSession });

  console.log(JSON.stringify({
    message: "Prepared disposable Coach fixture. Open each helper once, then run cleanup.",
    patientId: state.patientId,
    providerId: state.providerId,
    sourceConversationId: state.sourceConversationId,
    legacyConversationId: state.legacyConversationId,
    helperUrls: state.helperUrls,
  }, null, 2));
}

async function removeHelpers(state) {
  const files = state.helperFiles ?? {};
  await Promise.all([
    files.opsPublic ? rm(files.opsPublic, { force: true }) : undefined,
    files.mobilePublic ? rm(files.mobilePublic, { force: true }) : undefined,
    files.mobileStatic ? rm(files.mobileStatic, { force: true }) : undefined,
    files.providerMobilePublic ? rm(files.providerMobilePublic, { force: true }) : undefined,
    files.providerMobileStatic ? rm(files.providerMobileStatic, { force: true }) : undefined,
    files.tempDir ? rm(files.tempDir, { force: true, recursive: true }) : undefined,
  ]);
}

async function cleanup(state) {
  // Remove browser-readable session material first, even if a later database
  // cleanup is interrupted. The state manifest remains for a safe retry.
  await removeHelpers(state);
  const owner = sqlString(state.ownerEmail);
  const patient = sqlString(state.patientEmail);
  const provider = sqlString(state.providerId);
  const patientId = `${sqlString(state.patientId)}::uuid`;
  await sql(`
    begin;
    set local session_replication_role = replica;
    do $fixture$
    declare relation record;
    begin
      -- Future patient-owned tables are included without guessing their names.
      -- The UUID is this fixture's only scope, so no existing patient changes.
      for relation in
        select c.table_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema=c.table_schema and t.table_name=c.table_name
        where c.table_schema='public' and t.table_type='BASE TABLE'
          and c.column_name='patient_id'
          and c.table_name not in ('patients', 'patient_deletion_requests')
        order by c.table_name
      loop
        execute format('delete from public.%I where patient_id=$1', relation.table_name) using ${patientId};
      end loop;
      for relation in
        select c.table_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema=c.table_schema and t.table_name=c.table_name
        where c.table_schema='public' and t.table_type='BASE TABLE'
          and c.column_name='provider_id' and c.table_name <> 'providers'
        order by c.table_name
      loop
        execute format('delete from public.%I where provider_id=$1', relation.table_name) using ${provider};
      end loop;
    end $fixture$;
    delete from public.patient_deletion_requests where patient_id=${patientId};
    delete from public.claim_verifications where identifier in (${owner}, ${patient});
    delete from public.auth_sign_ins where user_id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid);
    delete from public.account_security_state where user_id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid);
    delete from public.training_viewers where auth_user_id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid);
    delete from public.staff_role_assignments where email in (${owner}, ${patient});
    delete from public.profiles where id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid)
      or email in (${owner}, ${patient});
    delete from public.patients where id=${patientId} or auth_user_id=${sqlString(state.patientUserId)}::uuid;
    delete from public.providers where provider_id=${provider} or auth_user_id=${sqlString(state.ownerId)}::uuid;
    delete from auth.identities where user_id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid);
    delete from auth.sessions where user_id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid);
    delete from auth.users where id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid)
      and email in (${owner}, ${patient});
    set local session_replication_role = origin;
    commit;
  `, "fixture cleanup transaction");
  const [remaining] = await sql(`
    select
      (select count(*) from auth.users where email in (${owner}, ${patient})) as auth_users,
      (select count(*) from public.providers where provider_id=${provider}) as providers,
      (select count(*) from public.patients where id=${patientId}) as patients,
      (select count(*) from public.profiles where email in (${owner}, ${patient})) as profiles,
      (select count(*) from public.auth_sign_ins where user_id in (${sqlString(state.ownerId)}::uuid, ${sqlString(state.patientUserId)}::uuid)) as sign_ins,
      (select count(*) from public.coach_memories where patient_id=${patientId}) as memories,
      (select count(*) from public.patient_chat_conversations where patient_id=${patientId}) as conversations,
      (select count(*) from public.patient_deletion_requests where patient_id=${patientId}) as deletion_requests
  `, "fixture cleanup verification");
  for (const [name, count] of Object.entries(remaining ?? {})) {
    assert.equal(Number(count), 0, `${name} fixture cleanup incomplete`);
  }
  await rm(statePath, { force: true });
  console.log(JSON.stringify({ message: "Coach browser fixture cleanup verified." }, null, 2));
}

try {
  if (command === "setup") await setup();
  else {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    validateState(state);
    if (command === "cleanup") await cleanup(state);
    else if (command === "provider-mobile-helper") {
      await writeProviderMobileHelper(state, await existingHelperSession(state.helperFiles?.opsTemp));
      console.log(JSON.stringify({
        message: "Prepared disposable Coach provider-mobile helper.",
        patientId: state.patientId,
        providerId: state.providerId,
        helperUrl: state.helperUrls?.providerMobile,
      }, null, 2));
    } else {
      await writePatientMobileHelper(state, await patientHelperSession(state.helperFiles?.mobileTemp));
      console.log(JSON.stringify({
        message: "Prepared disposable Coach patient-mobile helper.",
        helperUrl: state.helperUrls?.patient,
      }, null, 2));
    }
  }
} catch (error) {
  // Never emit response bodies, SQL, session data, or the private manifest.
  console.error(
    error?.code === "EEXIST"
      ? "A Coach browser fixture recovery manifest already exists. Run cleanup before setup."
      : error?.code === "ENOENT"
        ? "No Coach browser fixture recovery manifest exists."
        : error?.message ?? "Coach browser fixture failed.",
  );
  process.exitCode = 1;
}