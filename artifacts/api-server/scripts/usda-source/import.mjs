#!/usr/bin/env node
/**
 * No writes by default. Fully validates the file before any database work.
 * Credentials are runtime-only and are never printed, persisted or put in URLs.
 * All DML goes through three narrowly scoped, additive USDA-source functions.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATASETS } from './datasets.mjs';
import { foodBatches, inspectRelease } from './reader.mjs';

export function sqlJson(value) {
  return "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
}
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function safeSqlError(status, payload) {
  // Never echo an HTTP body: SQL/transport diagnostics may include source payloads.
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const known = [
    'USDA release manifest differs', 'USDA source record differs', 'USDA release is incomplete',
    'Cannot append records', 'USDA release exceeds', 'Duplicate USDA identifiers',
    'USDA record dataset or identifier is invalid', 'USDA batch must',
  ].find(message => text.includes(message));
  return `Supabase query failed (HTTP ${status})${known ? ': ' + known : '; inspect the database schema/connection, no response payload was logged'}`;
}

export function managementQuery(expectedProject) {
  const url = process.env.SUPABASE_URL;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!url || !token) throw new Error('SUPABASE_URL and SUPABASE_ACCESS_TOKEN must be configured in workspace secrets');
  const parsed = new URL(url);
  const ref = parsed.hostname.split('.')[0];
  if (parsed.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(parsed.hostname) || ref !== expectedProject) {
    throw new Error('Configured Supabase project does not match --project; no request sent');
  }
  return createQueryTransport(ref, token);
}

export function createQueryTransport(ref, token, {
  request = fetch, pause = sleep, now = Date.now, minimumIntervalMs = 1100,
} = {}) {
  let nextRequestAt = 0;
  return async query => {
    const body = JSON.stringify({ query });
    if (Buffer.byteLength(body) > 2_400_000) throw new Error('SQL request exceeds the safe 2.4 MB transport budget');
    for (let attempt = 0; attempt < 6; attempt++) {
      await pause(Math.max(0, nextRequestAt - now()));
      nextRequestAt = now() + minimumIntervalMs;
      let response;
      try {
        response = await request(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(90_000),
        });
      } catch {
        if (attempt === 5) throw new Error('Supabase connection failed after retries; rerun to resume the same immutable release');
        await pause(1000 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      if (response.status === 429 && attempt < 5) {
        const header = response.headers.get('retry-after');
        const seconds = header?.trim() ? Number(header) : NaN;
        const retryAt = header ? Date.parse(header) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000
          : Number.isFinite(retryAt) ? retryAt - now() : 60_000;
        // Respect provider cooldowns, including HTTP-date Retry-After values.
        const wait = Math.max(1000, delay);
        console.log(`Supabase rate limit: waiting ${Math.ceil(wait / 1000)}s before safely retrying.`);
        await pause(wait);
        continue;
      }
      if (response.status >= 500 && attempt < 5) {
        await pause(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(safeSqlError(response.status, text));
      let rows;
      try { rows = JSON.parse(text); } catch { throw new Error('Supabase returned invalid JSON'); }
      if (!Array.isArray(rows) || rows.length !== 1 || !Object.hasOwn(rows[0], 'result')) {
        throw new Error('Unexpected Supabase query result; import stopped');
      }
      return rows[0].result;
    }
    throw new Error('Supabase retry budget exhausted');
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    dataset: { type: 'string' }, file: { type: 'string' }, manifest: { type: 'string' },
    report: { type: 'string' }, project: { type: 'string' }, apply: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node import.mjs --dataset <release-id> --file <JSON> --manifest <manifest.json> [--apply --project <confirmed-ref>] [--report <receipt.json>]');
    console.log('Dry run validates and writes a manifest only. Apply requires an existing matching manifest and the USDA source migration. Releases: ' + Object.keys(DATASETS).join(', '));
    return;
  }
  const spec = DATASETS[values.dataset];
  if (!spec || !values.file || !values.manifest) throw new Error('Choose a supported --dataset, --file and --manifest; see --help');
  const file = resolve(values.file);
  const manifestPath = resolve(values.manifest);
  if (file === manifestPath || (values.report && [file, manifestPath].includes(resolve(values.report)))) {
    throw new Error('Input, manifest and report must be different files');
  }
  if (values.apply && !/^[a-z0-9]+$/.test(values.project ?? '')) throw new Error('--apply requires an explicit --project');
  console.log(`Inspecting ${values.dataset}; preserving original food, nutrient and portion data.`);
  const initialStat = await stat(file);
  const inspected = await inspectRelease(file, spec);
  if (inspected.foods < 1) throw new Error('The source contains no food records; nothing can be imported');
  if (inspected.maxRecordBytes + 2 > 650000) throw new Error('A source record exceeds the safe batch size; review the file before import');
  const afterInspect = await stat(file);
  if (initialStat.size !== afterInspect.size || initialStat.mtimeMs !== afterInspect.mtimeMs) throw new Error('Input file changed during inspection');
  // Normalize null-prototype coverage maps to their persisted JSON form.
  const manifest = JSON.parse(JSON.stringify({ id: values.dataset, ...spec, ...inspected }));
  if (!values.apply) {
    // Do not silently replace a reviewed manifest if the official download changes.
    try {
      const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!isDeepStrictEqual(previous, manifest)) throw new Error('Manifest file already exists with different content; use a new path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    }
    console.log(JSON.stringify({ mode: 'dry-run', id: manifest.id, foods: manifest.foods, nutrients: manifest.nutrients, portions: manifest.portions, sha256: manifest.sha256 }));
    return;
  }
  const approved = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isDeepStrictEqual(approved, manifest)) throw new Error('Input does not match the reviewed manifest; no database writes made');
  const query = managementQuery(values.project);
  // Dataset ids come only from the fixed registry, not from arbitrary input.
  const releaseSql = "'" + manifest.id + "'";
  const initialStatus = await query(`select public.begin_usda_source_release(${sqlJson(manifest)}) as result`);
  let verified = 0, inserted = 0, batches = 0;
  for await (const batch of foodBatches(file, spec)) {
    const result = await query(`select public.import_usda_source_food_batch(${releaseSql},${sqlJson(batch.foods)}) as result`);
    if (result?.verified !== batch.foods.length || !Number.isInteger(result.inserted)) throw new Error('Batch verification counts differ; import stopped');
    verified += result.verified;
    inserted += result.inserted;
    batches++;
    if (batches === 1 || batches % 20 === 0) console.log(`${manifest.id}: ${verified}/${manifest.foods} verified, ${inserted} newly inserted`);
  }
  // If the source changes mid-import, the release is left hidden/loading.
  if (verified !== manifest.foods || await fileHash(file) !== manifest.sha256) throw new Error('Source changed during import; release was not finalized');
  const result = await query(`select public.complete_usda_source_release(${releaseSql}) as result`);
  if (result?.status !== 'ready' || result.foods !== manifest.foods || result.nutrients !== manifest.nutrients || result.portions !== manifest.portions) {
    throw new Error('Completion verification failed');
  }
  const receipt = { ...result, initiallyReady: initialStatus === 'ready', inserted, verified, batches, sha256: manifest.sha256, completedAt: new Date().toISOString() };
  if (values.report) {
    await mkdir(dirname(resolve(values.report)), { recursive: true });
    await writeFile(resolve(values.report), JSON.stringify(receipt, null, 2) + '\n');
  }
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}