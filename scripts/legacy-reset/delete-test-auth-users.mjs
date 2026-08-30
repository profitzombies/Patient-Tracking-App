/**
 * Remove the two leftover test staff logins from GoTrue via the admin API.
 *
 * Guardrails:
 *   * The delete set is built ONLY from the two known test emails.
 *   * If Andrew's UUID or any email containing his address ever lands in the
 *     delete set, the script aborts before deleting anything.
 *   * After deleting, it asserts exactly one auth user remains and that it is
 *     Andrew — anything else is reported loudly.
 *
 * Deleting these users cascades their profiles rows (already removed by the
 * wipe) and nulls training_viewers.auth_user_id (rows already truncated).
 *
 * Usage: node scripts/legacy-reset/delete-test-auth-users.mjs --confirm-delete
 */
import { adminFetch, sql, OWNER_AUTH_ID, OWNER_EMAIL, TEST_STAFF_EMAILS } from "./lib.mjs";

if (process.argv[2] !== "--confirm-delete") {
  console.error("Refusing to run without --confirm-delete");
  process.exit(1);
}

const { status, json } = await adminFetch("GET", "/auth/v1/admin/users?per_page=100");
if (status !== 200) throw new Error(`admin list users failed: ${status}`);
const users = json.users ?? json;
console.log(`auth users found: ${users.length}`);

const wanted = new Set(TEST_STAFF_EMAILS.map((e) => e.toLowerCase()));
const deleteSet = users.filter((u) => wanted.has((u.email || "").toLowerCase()));

// Abort guard: Andrew must never appear in the delete set.
for (const u of deleteSet) {
  const email = (u.email || "").toLowerCase();
  if (u.id === OWNER_AUTH_ID || email === OWNER_EMAIL || email.includes("andrew")) {
    console.error(`ABORT: protected identity matched the delete set (${u.id})`);
    process.exit(1);
  }
}
if (deleteSet.length !== TEST_STAFF_EMAILS.length) {
  console.error(
    `ABORT: expected ${TEST_STAFF_EMAILS.length} test users, matched ${deleteSet.length} — refusing to guess`,
  );
  process.exit(1);
}

for (const u of deleteSet) {
  const res = await adminFetch("DELETE", `/auth/v1/admin/users/${u.id}`);
  if (res.status !== 200) throw new Error(`delete ${u.id} failed: ${res.status}`);
  console.log(`deleted auth user ${u.id} (${u.email})`);
}

// End-state: exactly Andrew remains, and his linked rows are intact.
const [state] = await sql(
  `select
     (select count(*) from auth.users) as auth_users,
     (select count(*) from auth.users where id = '${OWNER_AUTH_ID}' and lower(email) = '${OWNER_EMAIL}') as owner_present,
     (select count(*) from public.profiles) as profiles,
     (select count(*) from public.staff_role_assignments) as staff_role_assignments,
     (select count(*) from public.hq_memberships) as hq_memberships`,
);
console.log("post-delete state:", JSON.stringify(state));
if (state.auth_users !== 1 || state.owner_present !== 1 || state.profiles !== 1) {
  console.error("ABORT-STATE MISMATCH: expected exactly Andrew to remain — investigate immediately");
  process.exit(1);
}

await sql(
  `update legacy_archive.archive_manifest set live_rows_after_reset = 1, reset_at = now()
   where table_name = 'auth.users (manifest)'`,
  { label: "manifest auth after-count" },
);
console.log("AUTH CLEANUP COMPLETE — only Andrew's login remains");
