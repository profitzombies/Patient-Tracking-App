#!/usr/bin/env node
/**
 * Explicit, development-only fixtures for docs/org-policy-browser-check.md.
 * No browser tokens, passwords, helper pages, or production configuration.
 * Keep the private recovery manifest until cleanup has verified every row.
 */
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../.cache/org-policy-browser/", import.meta.url));
const statePath = `${dir}/state.json`;
const command = process.argv[2];
const commands = ["prepare", "inspect", "cleanup"];
if (!commands.includes(command) || !process.argv.includes("--allow-live-fixtures")) {
  console.error("Usage: node scripts/org-policy-browser-fixture.mjs prepare|inspect|cleanup --allow-live-fixtures");
  console.error("Shared Supabase writes: see docs/org-policy-browser-check.md. Not an automatic validation.");
  process.exit(2);
}
assert(process.env.NODE_ENV !== "production", "Refusing fixtures in a production process");
assert(process.env.REPLIT_DEV_DOMAIN, "Run only from the development workspace");
const required = (name) => {
  assert(process.env[name]?.trim(), `${name} must be configured in workspace secrets`);
  return process.env[name];
};
const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
const managementToken = required("SUPABASE_ACCESS_TOKEN");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const sqlString = (value) => value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const jsonSql = (value) => `${sqlString(JSON.stringify(value))}::jsonb`;

async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  // Do not echo SQL errors: they can contain private baseline settings.
  assert(response.ok, `Fixture SQL failed (${response.status}); recovery manifest retained`);
  return response.json();
}

async function authAdmin(method, path, body) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Fixture auth operation failed (${response.status}); recovery manifest retained`);
  return response.json();
}

async function save(state, exclusive = false) {
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: exclusive ? "wx" : "w" });
}

function validateState(state) {
  assert.match(state.run, /^[0-9a-f-]{36}$/);
  assert.equal(state.projectRef, projectRef, "Supabase project changed; refusing cross-project cleanup");
  assert.equal(state.providerId, `policy-browser-${state.run}`);
  assert.equal(state.hqEmail, `policy-hq-${state.run}@example.com`);
  assert.equal(state.officeEmail, `policy-office-${state.run}@example.com`);
  assert.match(state.memberId, /^[0-9a-f-]{36}$/);
}

async function prepare() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const [baseline] = await sql("select * from public.hq_organization_settings where singleton = true");
  assert(baseline, "HQ settings must already exist; this check does not seed global policy");
  const run = randomUUID();
  const state = {
    run, projectRef, baseline, memberId: randomUUID(),
    providerId: `policy-browser-${run}`,
    hqEmail: `policy-hq-${run}@example.com`,
    officeEmail: `policy-office-${run}@example.com`,
    hqValues: [`policy-first-${run}@example.com`, `policy-winner-${run}@example.com`],
    staleValue: `policy-stale-${run}@example.com`,
    officeValues: [`policy-override-${run}@example.com`, `policy-office-winner-${run}@example.com`],
  };
  // Write before any mutation, with exclusive creation to refuse overlapping runs.
  // Even an ambiguous network failure can be recovered by the exact fixture emails.
  await save(state, true);
  const hq = await authAdmin("POST", "users", {
    email: state.hqEmail, email_confirm: true,
    password: randomBytes(40).toString("base64url"),
    user_metadata: { display_name: "Policy Browser HQ" },
  });
  const hqId = hq.id ?? hq.user?.id;
  assert.match(hqId, /^[0-9a-f-]{36}$/);
  await sql(`
    begin;
    insert into public.hq_memberships
      (auth_user_id, email, display_name, department_role, status, activated_at)
      values (${sqlString(hqId)}, ${sqlString(state.hqEmail)}, 'Policy Browser HQ', 'admin', 'active', now());
    insert into public.providers
      (provider_id, provider_name, office_name, email, onboarding_code, access_disabled)
      values (${sqlString(state.providerId)}, 'Policy Browser Owner', 'Policy Browser Office',
        ${sqlString(`policy-owner-${run}@example.com`)}, ${sqlString(String(randomInt(100000, 1000000)))}, false);
    insert into public.team_members
      (id, provider_id, name, email, activation_status, office_role, created_at)
      values (${sqlString(state.memberId)}, ${sqlString(state.providerId)}, 'Policy Browser Manager',
        ${sqlString(state.officeEmail)}, 'activated', 'admin', now());
    commit;
  `);
  console.log(JSON.stringify({
    message: "Prepared. Use code login in temporary dev delivery mode; no password or token is shared.",
    hqEmail: state.hqEmail, officeEmail: state.officeEmail, providerId: state.providerId,
    initialVersion: baseline.version,
    hqValues: state.hqValues, staleValue: state.staleValue, officeValues: state.officeValues,
  }, null, 2));
}

async function inspect(state) {
  const rows = await sql(`
    select
      (select version from public.hq_organization_settings where singleton) as hq_version,
      (select escalation_email = ${sqlString(state.hqValues[1])}
        from public.hq_organization_settings where singleton) as hq_winner_persisted,
      (select count(*) from public.hq_memberships
        where email = ${sqlString(state.hqEmail)} and status = 'active' and department_role = 'admin') as hq_admins,
      (select count(*) from public.team_members where id = ${sqlString(state.memberId)}
        and auth_user_id is not null and office_role = 'admin') as signed_in_office_managers,
      (select version from public.provider_policy_overrides
        where provider_id = ${sqlString(state.providerId)}) as override_version,
      (select escalation_email from public.provider_policy_overrides
        where provider_id = ${sqlString(state.providerId)}) as override_email,
      (select count(*) from public.admin_audit_events where action = 'hq_settings_updated'
        and actor_user_id in (select id from auth.users where email = ${sqlString(state.hqEmail)})) as hq_audits,
      (select count(*) from public.admin_audit_events
        where provider_id = ${sqlString(state.providerId)} and action = 'office_policy_override_updated') as office_audits
  `);
  assert.equal(rows[0].hq_admins, 1, "Expected the disposable real HQ Admin membership");
  assert.equal(rows[0].signed_in_office_managers, 1, "Expected a real signed-in office admin");
  assert.equal(rows[0].hq_winner_persisted, true, "HQ winner must survive the stale save");
  assert(rows[0].hq_version >= state.baseline.version + 2, "Both HQ browser saves must bump version");
  assert(rows[0].override_version >= 2, "Office browser saves must bump the override version");
  assert.equal(rows[0].override_email, state.officeValues[1], "Office winner must survive reload/conflict");
  assert(rows[0].hq_audits >= 2 && rows[0].office_audits >= 2, "Both actors must leave real audit evidence");
  console.log(JSON.stringify(rows[0], null, 2));
}

async function cleanup(state) {
  const hq = sqlString(state.hqEmail);
  const office = sqlString(state.officeEmail);
  const provider = sqlString(state.providerId);
  const users = `select id from auth.users where email in (${hq}, ${office})`;
  // Lock the singleton; restore ONLY this check's field, never rewind version or
  // replace another administrator's changes. Abort if that field now belongs to
  // someone else, retaining the recovery manifest for deliberate reconciliation.
  await sql(`
    begin;
    select singleton from public.hq_organization_settings where singleton = true for update;
    do $restore$
    begin
      if exists (select 1 from public.hq_organization_settings where singleton = true
        and escalation_email is distinct from ${sqlString(state.baseline.escalation_email)}
        and (escalation_email not in (${state.hqValues.map(sqlString).join(",")})
          or escalation_email is null)) then
        raise exception 'Escalation destination changed outside this check; refusing to overwrite it';
      end if;
    end $restore$;
    update public.hq_organization_settings set
      escalation_email = ${sqlString(state.baseline.escalation_email)},
      version = version + 1,
      updated_at = now(),
      updated_by = case when updated_by in (${users}) then ${sqlString(state.baseline.updated_by)}::uuid else updated_by end,
      section_changes = case when section_changes->'coach'->>'by' in (select id::text from auth.users where email = ${hq})
        then (section_changes - 'coach') || ${jsonSql(state.baseline.section_changes?.coach ? { coach: state.baseline.section_changes.coach } : {})}
        else section_changes end
      where singleton = true and (escalation_email is distinct from ${sqlString(state.baseline.escalation_email)}
        or updated_by in (${users}) or section_changes->'coach'->>'by' in (select id::text from auth.users where email = ${hq}));
    -- The audit table is append-only; disable its delete guard in this
    -- transaction only, and only delete rows belonging to these disposable actors.
    set local session_replication_role = replica;
    delete from public.admin_audit_events where provider_id = ${provider} or actor_user_id in (${users});
    set local session_replication_role = origin;
    delete from public.provider_policy_overrides where provider_id = ${provider};
    delete from public.claim_verifications where identifier in (${hq}, ${office});
    delete from public.training_viewers where auth_user_id in (${users});
    delete from public.hq_memberships where email = ${hq} and is_protected_owner = false;
    delete from public.team_members where id = ${sqlString(state.memberId)} and provider_id = ${provider};
    delete from public.providers where provider_id = ${provider};
    commit;
  `);
  // GoTrue deletes auth sessions/identities/security rows through normal cascades.
  // If interrupted, the next cleanup call finds remaining users by exact email.
  const authUsers = await sql(`select id from auth.users where email in (${hq}, ${office})`);
  for (const user of authUsers) await authAdmin("DELETE", `users/${user.id}`);
  const [remaining] = await sql(`
    select
      (select count(*) from auth.users where email in (${hq}, ${office})) as auth_users,
      (select count(*) from public.profiles where email in (${hq}, ${office})) as profiles,
      (select count(*) from public.hq_memberships where email = ${hq}) as hq_memberships,
      (select count(*) from public.team_members where id = ${sqlString(state.memberId)}) as office_members,
      (select count(*) from public.providers where provider_id = ${provider}) as providers,
      (select count(*) from public.provider_policy_overrides where provider_id = ${provider}) as overrides,
      (select count(*) from public.claim_verifications where identifier in (${hq}, ${office})) as login_challenges,
      (select count(*) from public.admin_audit_events where provider_id = ${provider}
        or actor_user_id in (${authUsers.length ? authUsers.map(u => sqlString(u.id)).join(",") : "null"})) as audit_events,
      (select escalation_email is not distinct from ${sqlString(state.baseline.escalation_email)}
        from public.hq_organization_settings where singleton = true) as hq_value_restored
  `);
  assert.equal(remaining.hq_value_restored, true, "HQ escalation destination was not restored");
  for (const [name, count] of Object.entries(remaining)) {
    if (name !== "hq_value_restored") assert.equal(count, 0, `${name} fixture cleanup incomplete`);
  }
  console.log(JSON.stringify({ message: "Cleanup verified; restart API to clear the policy cache and dev delivery override.", ...remaining }, null, 2));
  await rm(statePath);
}

try {
  if (command === "prepare") await prepare();
  else {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    validateState(state);
    if (command === "inspect") await inspect(state);
    else await cleanup(state);
  }
} catch (error) {
  // No raw upstream body, request headers, session, or private manifest output.
  console.error(error.code === "EEXIST" ? "A recovery manifest already exists. Finish cleanup before preparing again."
    : error.code === "ENOENT" ? "No recovery manifest. Nothing to inspect or clean up."
    : error.message);
  process.exitCode = 1;
}