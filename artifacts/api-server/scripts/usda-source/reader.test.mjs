import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { foodBatches, inspectRelease, readFoods } from "./reader.mjs";

const spec = { rootKey: "SRLegacyFoods", dataType: "SR Legacy" };

async function fixture(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), "usda-reader-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "foods.json");
  await writeFile(path, contents);
  return path;
}

function food(id, additions = {}) {
  return {
    fdcId: id,
    description: `Food ${id}`,
    dataType: "SR Legacy",
    foodNutrients: [],
    ...additions,
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("streams and preserves nested, escaped, unknown, and chunk-crossing data", async (t) => {
  const long = `${"x".repeat(70_000)} \\" tail`;
  const original = food(1, {
    description: "Chef's $5 DROP TABLE foods; --",
    nested: { arrays: [[{ quote: 'say "hi"', slash: "\\\\" }]] },
    long,
    foodPortions: [{ portionDescription: "arbitrary handful / user's choice" }],
  });
  const source = JSON.stringify({ SRLegacyFoods: [original] });
  const path = await fixture(t, source);
  assert.deepEqual(await collect(readFoods(path, spec)), [original]);

  const report = await inspectRelease(path, spec);
  assert.equal(report.sha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(report.bytes, Buffer.byteLength(source));
  assert.equal(report.foods, 1);
  assert.equal(report.portions, 1);
  assert.equal(report.withPortions, 1);
  assert.equal(report.maxRecordBytes, Buffer.byteLength(JSON.stringify(original)));
});

test("accepts BOM and arbitrary JSON whitespace", async (t) => {
  const path = await fixture(t, `\ufeff \r\n { \t"SRLegacyFoods" : [ ${JSON.stringify(food(2))} ] }\n`);
  assert.equal((await collect(readFoods(path, spec)))[0].fdcId, 2);
});

test("counts zero amounts, not missing amounts, once per food", async (t) => {
  const first = food(1, {
    foodNutrients: [
      { nutrient: { id: 1008 }, amount: 0 },
      { nutrient: { id: 1008 }, amount: 2 },
      { nutrient: { id: 1003 } },
      { nutrient: { id: 1004 }, amount: null },
    ],
  });
  const second = food(2, {
    foodNutrients: [{ nutrient: { id: 1008 }, amount: -1 }],
    foodPortions: [],
  });
  const path = await fixture(t, JSON.stringify({ SRLegacyFoods: [first, second] }));
  const report = await inspectRelease(path, spec);
  assert.equal(report.nutrients, 5);
  assert.deepEqual({ ...report.nutrientCoverage }, { 1008: 2 });
  assert.equal(report.portions, 0);
  assert.equal(report.withPortions, 0);
});

test("rejects duplicate IDs during inspection", async (t) => {
  const path = await fixture(t, JSON.stringify({ SRLegacyFoods: [food(7), food(7)] }));
  await assert.rejects(inspectRelease(path, spec), /duplicate fdcId 7/);
});

test("rejects wrong source and malformed envelopes", async (t) => {
  const cases = [
    [JSON.stringify({ SurveyFoods: [food(1)] }), /unexpected root key/],
    ['{"SRLegacyFoods":[],"other":[]}', /only the expected array key/],
    ['{"SRLegacyFoods":[', /truncated|end of file/],
    ['{"SRLegacyFoods":[,]}', /food must be a JSON object/],
    [`{"SRLegacyFoods":[${JSON.stringify(food(1))},]}`, /trailing comma/],
    [`{"SRLegacyFoods":[${JSON.stringify(food(1))} ${JSON.stringify(food(2))}]}`, /comma/],
    ['{"SRLegacyFoods":[]} true', /trailing content/],
  ];
  for (const [contents, pattern] of cases) {
    const path = await fixture(t, contents);
    await assert.rejects(collect(readFoods(path, spec)), pattern);
  }
});

test("validates required food fields without normalizing them", async (t) => {
  const invalid = [
    food(0),
    food(1, { description: "" }),
    food(1, { dataType: "Survey (FNDDS)" }),
    food(1, { foodNutrients: null }),
    food(1, { foodPortions: {} }),
  ];
  for (const value of invalid) {
    const path = await fixture(t, JSON.stringify({ SRLegacyFoods: [value] }));
    await assert.rejects(collect(readFoods(path, spec)));
  }
});

test("batches by exact UTF-8 array byte size and food count", async (t) => {
  const values = [
    food(1, { description: "ééé" }),
    food(2, { description: "🥑" }),
    food(3),
  ];
  const path = await fixture(t, JSON.stringify({ SRLegacyFoods: values }));
  const firstArrayBytes = Buffer.byteLength(JSON.stringify(values.slice(0, 2)));
  const batches = await collect(foodBatches(path, spec, { maxBytes: firstArrayBytes, maxFoods: 2 }));
  assert.deepEqual(batches.map(({ foods }) => foods.map(({ fdcId }) => fdcId)), [[1, 2], [3]]);
  for (const batch of batches) {
    assert.equal(batch.bytes, Buffer.byteLength(JSON.stringify(batch.foods)));
    assert.ok(batch.bytes <= firstArrayBytes);
  }
  await assert.rejects(
    collect(foodBatches(path, spec, { maxBytes: Buffer.byteLength(JSON.stringify([values[0]])) - 1 })),
    /exceeds maxBytes/,
  );
});

test("validates batch limits", async (t) => {
  const path = await fixture(t, JSON.stringify({ SRLegacyFoods: [] }));
  await assert.rejects(collect(foodBatches(path, spec, { maxBytes: 1 })), /maxBytes/);
  await assert.rejects(collect(foodBatches(path, spec, { maxFoods: 0 })), /maxFoods/);
});

test("opt-in null records are skipped and retain source positions", async (t) => {
  const entries = [null, food(1), null, food(2), null];
  const path = await fixture(t, JSON.stringify({ SRLegacyFoods: entries }));
  const optedIn = { ...spec, allowNullRecords: true };

  assert.deepEqual(
    (await collect(readFoods(path, optedIn))).map(({ fdcId }) => fdcId),
    [1, 2],
  );
  const report = await inspectRelease(path, optedIn);
  assert.equal(report.foods, 2);
  assert.equal(report.sourceEntries, 5);
  assert.equal(report.nullEntries, 3);
  assert.deepEqual(report.nullPositions, [0, 2, 4]);
  assert.equal(report.nutrients, 0);

  const batches = await collect(foodBatches(path, optedIn, { maxFoods: 1 }));
  assert.deepEqual(batches.map(({ foods }) => foods.map(({ fdcId }) => fdcId)), [[1], [2]]);
});

test("all-null arrays report evidence but yield no foods or batches", async (t) => {
  const path = await fixture(t, '{"SRLegacyFoods":[null,null]}');
  const optedIn = { ...spec, allowNullRecords: true };
  const report = await inspectRelease(path, optedIn);
  assert.equal(report.foods, 0);
  assert.equal(report.sourceEntries, 2);
  assert.equal(report.nullEntries, 2);
  assert.deepEqual(report.nullPositions, [0, 1]);
  assert.equal(report.maxRecordBytes, 0);
  assert.deepEqual(await collect(readFoods(path, optedIn)), []);
  assert.deepEqual(await collect(foodBatches(path, optedIn)), []);
});

test("null records remain invalid without explicit opt-in", async (t) => {
  const path = await fixture(t, `{"SRLegacyFoods":[${JSON.stringify(food(1))},null]}`);
  await assert.rejects(collect(readFoods(path, spec)), /allowNullRecords=true/);
  await assert.rejects(inspectRelease(path, spec), /allowNullRecords=true/);
});