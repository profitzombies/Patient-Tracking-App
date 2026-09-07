#!/usr/bin/env node
// Run a SQL file (or stdin) against the project's Supabase through the
// management API. Usage: node scripts/supabase-sql.mjs path/to/file.sql
//                        echo "select 1" | node scripts/supabase-sql.mjs -
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: supabase-sql.mjs <file.sql|->");
  process.exit(2);
}
const query = readFileSync(file === "-" ? 0 : file, "utf8");
const url = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!url || !token) {
  console.error("SUPABASE_URL and SUPABASE_ACCESS_TOKEN must be set");
  process.exit(2);
}
const ref = new URL(url).host.split(".")[0];
const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
});
const text = await response.text();
console.log(response.status);
console.log(text.slice(0, 20000));
process.exit(response.ok ? 0 : 1);
