/**
 * Inventory App Storage after the reset. Lists every object in the default
 * bucket, groups by top-level prefix, and reports which groups are kept.
 *
 * Deliberately conservative: training/knowledge media and the legacy export
 * are kept, and anything not clearly owned by a wiped test person is kept
 * too. This script DELETES NOTHING — it only reports; any deletion would be
 * a separate, explicit step (none is expected: the two test staff logins
 * never owned uploaded files).
 *
 * Usage: node scripts/legacy-reset/inventory-app-storage.mjs
 */
import { createRequire } from "node:module";

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

const dirs = new Set();
for (const env of ["PRIVATE_OBJECT_DIR", "TRAINING_OBJECT_DIR"]) {
  const value = (process.env[env] || "").replace(/\/$/, "");
  if (value) dirs.add(value);
}
for (const p of (process.env.PUBLIC_OBJECT_SEARCH_PATHS || "").split(",")) {
  const value = p.trim().replace(/\/$/, "");
  if (value) dirs.add(value);
}

const buckets = new Set([...dirs].map((d) => d.split("/")[1]).filter(Boolean));

for (const bucketName of buckets) {
  console.log(`bucket-scan: listing all objects`);
  const [files] = await storage.bucket(bucketName).getFiles();
  const groups = new Map();
  for (const file of files) {
    const relative = file.name;
    const parts = relative.split("/");
    // group by the two segments after the base dir (.private/<group> or public/<group>)
    const group = parts.slice(0, Math.min(parts.length - 1, 2)).join("/") || "(root)";
    const entry = groups.get(group) || { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += Number(file.metadata.size || 0);
    groups.set(group, entry);
  }
  console.log(`objects total: ${files.length}`);
  for (const [group, { count, bytes }] of [...groups.entries()].sort()) {
    console.log(`  ${group}  files=${count}  bytes=${bytes}`);
  }
}
console.log("inventory complete — nothing deleted by design");
