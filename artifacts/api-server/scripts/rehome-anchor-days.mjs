#!/usr/bin/env node
/**
 * One-time audited repair: move real accounts' rows stranded on the demo
 * anchor day (2026-08-22) onto the local calendar day their creation
 * timestamp falls in, in the patient's timezone.
 *
 * Why rows got stranded: live patient screens used to stamp saves with the
 * fixed demo anchor date. Now that reads follow the real day, those rows
 * are invisible. Each anchor row is mapped through its own creation
 * timestamp (water rows have no created_at; their single-day upsert makes
 * updated_at the honest stand-in), so a row keeps the day the patient
 * actually logged it.
 *
 * Safety:
 *   - Dry-run by default; pass --apply to write.
 *   - A row whose timestamp maps back onto the anchor day itself is left
 *     alone (a genuine Aug 22 log, not a stranding).
 *   - Water/check-in rows are unique per (patient_id, date_key): if the
 *     target day already has a row, the move is SKIPPED and reported for
 *     manual review instead of silently merging.
 *   - Patients with no stored timezone map through the documented fallback
 *     (America/New_York) and are flagged in the audit output.
 *
 * Usage:  node scripts/rehome-anchor-days.mjs [--apply]
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const ANCHOR = "2026-08-22";
const FALLBACK_TZ = "America/New_York";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");

async function rest(method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: method === "PATCH" ? "return=representation" : "count=exact",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (res.status >= 300) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, contentRange: res.headers.get("content-range") };
}

function dayInZone(isoTimestamp, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTimestamp));
}

/** patient_id -> { timezone, label } for every patient referenced. */
async function patientDirectory(ids) {
  if (ids.length === 0) return new Map();
  const list = ids.map(id => `"${id}"`).join(",");
  const { json } = await rest(
    "GET",
    `/rest/v1/patients?id=in.(${list})&select=id,first_name,last_name,timezone`,
  );
  const map = new Map();
  for (const row of json ?? []) {
    map.set(row.id, {
      timezone: typeof row.timezone === "string" && row.timezone.trim() ? row.timezone : null,
      label: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.id,
    });
  }
  return map;
}

async function countAt(table, dateKey) {
  const res = await rest(
    "GET",
    `/rest/v1/${table}?date_key=eq.${dateKey}&select=patient_id&limit=1`,
  );
  const range = res.contentRange ?? "";
  const total = range.includes("/") ? Number(range.split("/")[1]) : NaN;
  return Number.isFinite(total) ? total : (res.json ?? []).length;
}

const TABLES = [
  {
    table: "patient_diary_entries",
    ts: "created_at",
    keyCols: row => `entry_id=eq.${encodeURIComponent(row.entry_id)}`,
    select: "patient_id,entry_id,name,created_at",
    describe: row => `entry ${row.entry_id} ("${row.name}")`,
    uniquePerDay: false,
  },
  {
    table: "patient_water_days",
    ts: "updated_at",
    keyCols: row => `date_key=eq.${ANCHOR}`,
    select: "patient_id,date_key,oz,updated_at",
    describe: row => `water ${row.oz} oz`,
    uniquePerDay: true,
  },
  {
    table: "patient_check_ins",
    ts: "created_at",
    keyCols: row => `check_in_id=eq.${encodeURIComponent(row.check_in_id)}`,
    select: "patient_id,check_in_id,mood,weight,created_at",
    describe: row => `check-in ${row.check_in_id} (mood ${row.mood})`,
    uniquePerDay: true,
  },
  {
    table: "patient_progress_photos",
    ts: "created_at",
    keyCols: row => `photo_id=eq.${encodeURIComponent(row.photo_id)}`,
    select: "patient_id,photo_id,label,created_at",
    describe: row => `photo ${row.photo_id} ("${row.label}")`,
    uniquePerDay: false,
  },
];

async function main() {
  console.log(`Re-home stranded anchor rows (${ANCHOR}) — ${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`Started ${new Date().toISOString()}\n`);

  let planned = 0;
  let moved = 0;
  let skipped = 0;

  for (const spec of TABLES) {
    const { json: rows } = await rest(
      "GET",
      `/rest/v1/${spec.table}?date_key=eq.${ANCHOR}&select=${spec.select}`,
    );
    const before = await countAt(spec.table, ANCHOR);
    console.log(`── ${spec.table}: ${before} row(s) at anchor`);
    if ((rows ?? []).length === 0) {
      console.log("   nothing to do\n");
      continue;
    }

    const directory = await patientDirectory([...new Set(rows.map(r => r.patient_id))]);
    for (const row of rows) {
      const who = directory.get(row.patient_id) ?? { timezone: null, label: row.patient_id };
      const tz = who.timezone ?? FALLBACK_TZ;
      const tzNote = who.timezone ? tz : `${tz} (FALLBACK — no stored timezone)`;
      const stamp = row[spec.ts];
      if (!stamp) {
        console.log(`   SKIP ${spec.describe(row)} [${who.label}]: no ${spec.ts} timestamp`);
        skipped += 1;
        continue;
      }
      const target = dayInZone(stamp, tz);
      if (target === ANCHOR) {
        console.log(`   KEEP ${spec.describe(row)} [${who.label}]: genuinely logged ${ANCHOR}`);
        continue;
      }
      if (spec.uniquePerDay) {
        const { json: clash } = await rest(
          "GET",
          `/rest/v1/${spec.table}?patient_id=eq.${row.patient_id}&date_key=eq.${target}&select=patient_id&limit=1`,
        );
        if ((clash ?? []).length > 0) {
          console.log(
            `   SKIP ${spec.describe(row)} [${who.label}]: ${target} already has a row — manual review`,
          );
          skipped += 1;
          continue;
        }
      }
      planned += 1;
      console.log(
        `   MOVE ${spec.describe(row)} [${who.label}] ${ANCHOR} -> ${target}` +
          `  (${spec.ts} ${stamp}, tz ${tzNote})`,
      );
      if (APPLY) {
        const filter = `patient_id=eq.${row.patient_id}&${spec.keyCols(row)}&date_key=eq.${ANCHOR}`;
        const res = await rest("PATCH", `/rest/v1/${spec.table}?${filter}`, {
          date_key: target,
        });
        const changed = Array.isArray(res.json) ? res.json.length : 0;
        if (changed !== 1) throw new Error(`expected to move 1 row, matched ${changed}`);
        moved += 1;
      }
    }
    const after = await countAt(spec.table, ANCHOR);
    console.log(`   anchor rows after: ${APPLY ? after : `${before} (dry-run)`}\n`);
  }

  console.log(
    `${APPLY ? "Moved" : "Would move"} ${APPLY ? moved : planned} row(s); skipped ${skipped}.`,
  );
  if (!APPLY) console.log("Re-run with --apply to write.");
}

main().catch(error => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
