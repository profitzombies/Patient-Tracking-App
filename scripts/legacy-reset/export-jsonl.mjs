/**
 * Second, independent copy of the core business tables: JSONL files written
 * to a dated folder in private App Storage (PRIVATE_OBJECT_DIR), alongside an
 * auth-users manifest (ids/emails/timestamps/metadata — never password
 * hashes or tokens).
 *
 * Rows are read from the still-intact public tables through PostgREST with
 * the service-role key (paged by primary key; PostgREST max_rows is 1000),
 * and every file's line count is asserted against the verified
 * legacy_archive.archive_manifest counts before upload.
 *
 * Usage: node scripts/legacy-reset/export-jsonl.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sql, adminFetch } from "./lib.mjs";

const require = createRequire("/home/runner/workspace/artifacts/api-server/package.json");
const { Storage } = require("@google-cloud/storage");

const SIDECAR = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const EXPORT_TABLES = [
  ["providers", "provider_id"],
  ["patients", "id"],
  ["customers", "patient_id"],
  ["team_members", "id"],
  ["app_subscriptions", "id"],
  ["product_subscriptions", "id"],
  ["transactions", "id"],
  ["provider_referrals", "id"],
  ["patient_measurements", "patient_id"],
  ["provider_measurements", "provider_id"],
  ["claim_verifications", "id"],
];

const AUTH_COLUMNS =
  "id, aud, role, email, phone, created_at, updated_at, last_sign_in_at, " +
  "email_confirmed_at, phone_confirmed_at, confirmed_at, invited_at, " +
  "confirmation_sent_at, recovery_sent_at, email_change_sent_at, banned_until, " +
  "deleted_at, is_sso_user, is_anonymous, is_super_admin, raw_app_meta_data, raw_user_meta_data";

const privateDir = (process.env.PRIVATE_OBJECT_DIR || "").replace(/\/$/, "");
if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR is not configured");
const [, bucketName, ...baseParts] = privateDir.split("/");
const basePath = baseParts.join("/");
const FOLDER = "legacy-export-2026-08-30";

const expected = Object.fromEntries(
  (await sql("select table_name, archived_rows from legacy_archive.archive_manifest")).map(
    (row) => [row.table_name, Number(row.archived_rows)],
  ),
);

mkdirSync("/tmp/legacy-export", { recursive: true });
const summary = { exportedAt: new Date().toISOString(), folder: FOLDER, files: {} };

async function fetchAllRows(table, pk) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { status, json } = await adminFetch(
      "GET",
      `/rest/v1/${table}?select=*&order=${pk}.asc&limit=1000&offset=${offset}`,
    );
    if (status !== 200) throw new Error(`${table}: PostgREST ${status}`);
    rows.push(...json);
    if (json.length < 1000) break;
  }
  return rows;
}

async function saveAndUpload(name, rows) {
  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  const local = `/tmp/legacy-export/${name}.jsonl`;
  writeFileSync(local, jsonl);
  const sha256 = createHash("sha256").update(jsonl).digest("hex");
  const objectName = `${basePath}/${FOLDER}/${name}.jsonl`;
  await storage.bucket(bucketName).file(objectName).save(readFileSync(local), {
    metadata: { contentType: "application/x-ndjson" },
    resumable: false,
  });
  const [meta] = await storage.bucket(bucketName).file(objectName).getMetadata();
  if (Number(meta.size) !== Buffer.byteLength(jsonl)) {
    throw new Error(`${name}: uploaded size ${meta.size} != local ${Buffer.byteLength(jsonl)}`);
  }
  summary.files[name] = { rows: rows.length, bytes: Buffer.byteLength(jsonl), sha256 };
  console.log(`uploaded ${name}.jsonl  rows=${rows.length}  bytes=${Buffer.byteLength(jsonl)}`);
}

for (const [table, pk] of EXPORT_TABLES) {
  const rows = await fetchAllRows(table, pk);
  if (rows.length !== expected[table]) {
    throw new Error(`${table}: fetched ${rows.length} rows, archive manifest says ${expected[table]}`);
  }
  await saveAndUpload(table, rows);
}

const authRows = await sql(`select ${AUTH_COLUMNS} from auth.users order by created_at`);
if (authRows.length !== expected["auth.users (manifest)"]) {
  throw new Error(`auth manifest: ${authRows.length} != ${expected["auth.users (manifest)"]}`);
}
await saveAndUpload("auth_users_manifest", authRows);

await saveAndUpload("_row_count_manifest", await sql(
  "select table_name, source_rows, archived_rows, archived_at from legacy_archive.archive_manifest order by table_name",
));

const summaryText = JSON.stringify(summary, null, 2);
await storage
  .bucket(bucketName)
  .file(`${basePath}/${FOLDER}/_export_summary.json`)
  .save(summaryText, { metadata: { contentType: "application/json" }, resumable: false });
writeFileSync("/tmp/t366_export_summary.json", summaryText);
console.log(`export complete → App Storage private dir, folder ${FOLDER}`);
