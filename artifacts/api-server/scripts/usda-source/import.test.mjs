import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQueryTransport, main, safeSqlError, sqlJson } from './import.mjs';

const food = {
  fdcId: 1, description: "Farmer's milk · 1 cup", dataType: 'SR Legacy',
  foodNutrients: [{ nutrient: { id: 1003, name: 'Protein', unitName: 'g' }, amount: 0 }],
};
test('SQL JSON literals preserve unicode, backslashes and double apostrophes safely', () => {
  const value = { ...food, note: "'; drop table anything; -- \\n $$" };
  const literal = sqlJson(value);
  assert.deepEqual(JSON.parse(literal.slice(1, -8).replaceAll("''", "'")), value);
  assert.ok(literal.includes("Farmer''s"));
});

test('HTTP errors never echo raw SQL or credential-like payloads', () => {
  assert.equal(safeSqlError(400, 'source payload private'), 'Supabase query failed (HTTP 400); inspect the database schema/connection, no response payload was logged');
  assert.equal(safeSqlError(400, 'USDA release manifest differs SECRET'), 'Supabase query failed (HTTP 400): USDA release manifest differs');
});

test('query transport paces calls and respects both Retry-After formats without changing the batch', async () => {
  let clock = Date.UTC(2026, 8, 8), calls = 0;
  const waits = [], requests = [];
  const query = createQueryTransport('testproject', 'test-only-token', {
    now: () => clock,
    pause: async ms => { waits.push(ms); clock += ms; },
    request: async (url, init) => {
      requests.push(init.body);
      calls++;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
      if (calls === 2) return new Response('rate limited', { status: 429, headers: { 'retry-after': new Date(clock + 45_000).toUTCString() } });
      return Response.json([{ result: { verified: 1, inserted: calls === 3 ? 1 : 0 } }]);
    },
  });
  const sql = 'select test as result';
  assert.equal((await query(sql)).inserted, 1);
  assert.equal((await query(sql)).inserted, 0);
  assert.deepEqual(requests, Array(4).fill(JSON.stringify({ query: sql })));
  assert.ok(waits.includes(30_000));
  assert.ok(waits.includes(45_000));
  assert.ok(waits.includes(1100));
});

test('missing Retry-After uses a full minute cooldown; oversized bodies make no request', async () => {
  let calls = 0;
  const waits = [];
  const query = createQueryTransport('testproject', 'test-only-token', {
    now: () => 0, pause: async ms => { waits.push(ms); },
    request: async () => ++calls === 1
      ? new Response('rate limited', { status: 429 })
      : Response.json([{ result: 'ok' }]),
  });
  assert.equal(await query('select test as result'), 'ok');
  assert.ok(waits.includes(60_000));
  await assert.rejects(query('x'.repeat(2_400_001)), /transport budget/);
  assert.equal(calls, 2);
});

test('dry run is network-free; reviewed files cannot be silently replaced; apply pins inputs before connecting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usda-import-cli-'));
  const file = join(dir, 'foods.json'), manifest = join(dir, 'manifest.json');
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Network must not be used'); };
  const args = ['--dataset','sr-legacy-2018-04','--file',file,'--manifest',manifest];
  try {
    await writeFile(file, JSON.stringify({ SRLegacyFoods: [food] }));
    await main(args);
    const reviewed = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(reviewed.foods, 1);
    assert.equal(reviewed.nutrientCoverage['1003'], 1);
    // Key ordering is not a meaningful change to a JSON manifest.
    await writeFile(manifest, JSON.stringify(Object.fromEntries(Object.entries(reviewed).reverse())));
    await main(args);
    await assert.rejects(main([...args,'--apply']), /explicit --project/);
    await writeFile(file, JSON.stringify({ SRLegacyFoods: [{ ...food, description: 'Changed source' }] }));
    await assert.rejects(main(args), /different content/);
    await assert.rejects(main([...args,'--apply','--project','testproject']), /does not match the reviewed manifest/);
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), reviewed);
  } finally {
    globalThis.fetch = fetchBefore;
    await rm(dir, { recursive: true, force: true });
  }
});

test('input files cannot be overwritten by a manifest/report and all-null files cannot be imported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usda-import-guards-'));
  const file = join(dir, 'foods.json'), manifest = join(dir, 'manifest.json');
  try {
    const args = ['--dataset','foundation-2026-04','--file',file,'--manifest',manifest];
    await writeFile(file, '{"FoundationFoods":[null,null]}');
    await assert.rejects(main([...args,'--manifest',file]), /different files/);
    await assert.rejects(main([...args,'--report',file]), /different files/);
    await assert.rejects(main(args), /no food records/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});