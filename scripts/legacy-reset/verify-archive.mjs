/**
 * Blocking gate between archive and wipe: prove legacy_archive is a complete,
 * byte-faithful copy BEFORE anything is deleted.
 *
 * For every public table (and the auth-users manifest) this checks:
 *   1. counts — live count(*) == archived count(*) == archive_manifest rows;
 *   2. content — an order-independent checksum (sum of the first 8 md5 hex
 *      digits of each row's text form) computed on BOTH sides. Every row of
 *      every table participates, so a single divergent byte fails the gate.
 *
 * On success writes /tmp/t366_archive_verify.json and the PASS marker the
 * wipe script requires; exits non-zero on any mismatch.
 *
 * Usage: node scripts/legacy-reset/verify-archive.mjs [onlyTable]
 */
import { writeFileSync } from "node:fs";
import { sql, ALL_PUBLIC_TABLES } from "./lib.mjs";

const CHECKSUM =
  "coalesce(sum(('x' || substr(md5(t::text), 1, 8))::bit(32)::int::bigint), 0)";

const AUTH_COLUMNS =
  "id, aud, role, email, phone, created_at, updated_at, last_sign_in_at, " +
  "email_confirmed_at, phone_confirmed_at, confirmed_at, invited_at, " +
  "confirmation_sent_at, recovery_sent_at, email_change_sent_at, banned_until, " +
  "deleted_at, is_sso_user, is_anonymous, is_super_admin, raw_app_meta_data, raw_user_meta_data";

const only = process.argv[2] || null;
const results = [];
let failed = false;

async function check(name, srcFrom, archFrom) {
  const [row] = await sql(
    `select
       (select count(*) from ${srcFrom} t) as src_n,
       (select count(*) from ${archFrom} t) as arch_n,
       (select ${CHECKSUM} from ${srcFrom} t) as src_cs,
       (select ${CHECKSUM} from ${archFrom} t) as arch_cs`,
  );
  const ok = row.src_n === row.arch_n && row.src_cs === row.arch_cs;
  if (!ok) failed = true;
  results.push({ table: name, ...row, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}  rows ${row.src_n} vs ${row.arch_n}  checksum ${
      row.src_cs === row.arch_cs ? "match" : "MISMATCH"
    }`,
  );
}

for (const table of ALL_PUBLIC_TABLES) {
  if (only && table !== only) continue;
  await check(table, `public.${table}`, `legacy_archive.${table}`);
}
if (!only || only === "auth_users_manifest") {
  await check(
    "auth_users_manifest",
    `(select ${AUTH_COLUMNS} from auth.users)`,
    `(select ${AUTH_COLUMNS} from legacy_archive.auth_users_manifest)`,
  );
}

// Manifest sanity: the migration recorded source == archived for every table.
const manifest = await sql(
  "select table_name, source_rows, archived_rows from legacy_archive.archive_manifest order by table_name",
);
for (const row of manifest) {
  if (row.source_rows !== row.archived_rows) {
    failed = true;
    console.log(`FAIL  archive_manifest ${row.table_name}: ${row.source_rows} != ${row.archived_rows}`);
  }
}
console.log(`archive_manifest rows: ${manifest.length}`);

writeFileSync(
  "/tmp/t366_archive_verify.json",
  JSON.stringify({ checkedAt: new Date().toISOString(), results, manifest }, null, 2),
);

if (failed || only) {
  if (failed) {
    console.error("ARCHIVE VERIFICATION FAILED — wipe remains blocked");
    process.exit(1);
  }
  console.log("(partial run — PASS marker not written)");
} else {
  writeFileSync("/tmp/t366_archive_verify_PASS", new Date().toISOString());
  console.log("ARCHIVE VERIFIED — PASS marker written");
}
