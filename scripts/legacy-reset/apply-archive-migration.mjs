/**
 * Apply supabase/migrations/20260910000000_legacy_archive.sql through the
 * management API, batch by batch (`-- apply-batch: N` markers). Each batch is
 * posted verbatim so the repo migration stays canonical. Re-running is safe:
 * every copy is CREATE TABLE IF NOT EXISTS and each CTAS is atomic.
 *
 * Usage: node scripts/legacy-reset/apply-archive-migration.mjs [batchNumber]
 */
import { readFileSync } from "node:fs";
import { sql } from "./lib.mjs";

const MIGRATION = new URL(
  "../../supabase/migrations/20260910000000_legacy_archive.sql",
  import.meta.url,
);

const source = readFileSync(MIGRATION, "utf8");
const parts = source.split(/^-- apply-batch: (\d+)$/m);
// parts: [preamble, "1", sql1, "2", sql2, ...]
const batches = [];
for (let i = 1; i < parts.length; i += 2) {
  batches.push({ n: Number(parts[i]), body: parts[i + 1] });
}
if (batches.length === 0) throw new Error("no apply-batch markers found");

const only = process.argv[2] ? Number(process.argv[2]) : null;

for (const batch of batches) {
  if (only !== null && batch.n !== only) continue;
  console.log(`Applying batch ${batch.n}...`);
  await sql(batch.body, { label: `batch ${batch.n}` });
}
console.log("done");
