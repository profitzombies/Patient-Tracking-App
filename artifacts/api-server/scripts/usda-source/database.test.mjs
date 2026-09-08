import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const migration = fileURLToPath(
  new URL("../../../../supabase/migrations/20261003000000_usda_source_library.sql", import.meta.url),
);
const poisonedEnvironment = {
  ...process.env,
  PGHOST: "do-not-use.invalid",
  PGDATABASE: "do_not_use",
  PGUSER: "do_not_use",
  PGPORT: "1",
  PGPASSWORD: "do-not-use",
};

function encodedJson(value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  return `convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb`;
}

function manifest(id, version, { foods, nutrients, portions }) {
  return {
    id,
    dataset: "sr_legacy",
    version,
    rootKey: "SRLegacyFoods",
    dataType: "SR Legacy",
    sourceUrl: `https://fdc.nal.usda.gov/fdc-datasets/${version}.json.zip`,
    filename: `FoodData_Central_sr_legacy_food_json_${version}.zip`,
    sha256: "a".repeat(64),
    bytes: 123456,
    foods,
    nutrients,
    portions,
  };
}

function food(fdcId, additions = {}) {
  return {
    fdcId,
    description: `Food ${fdcId}`,
    dataType: "SR Legacy",
    foodNutrients: [],
    ...additions,
  };
}

test("USDA source migration is isolated, lossless, immutable, and locked down", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usda-source-pg-"));
  const data = join(directory, "data");
  const socket = join(directory, "socket");
  await exec("mkdir", ["-p", socket]);
  let started = false;

  t.after(async () => {
    try {
      if (started) {
        await exec("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], {
          env: poisonedEnvironment,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await exec("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], {
    env: poisonedEnvironment,
  });
  await exec("pg_ctl", [
    "-D",
    data,
    "-l",
    join(directory, "postgres.log"),
    "-o",
    `-F -p 5432 -k ${socket} -h ''`,
    "-w",
    "start",
  ], { env: poisonedEnvironment });
  started = true;

  const connection = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", "5432", "-d", "postgres", "-U", "postgres"];
  async function sql(statement, role = null) {
    const command = role ? `set role ${role}; ${statement}` : statement;
    const { stdout } = await exec("psql", [...connection, "-A", "-t", "-c", command], {
      env: poisonedEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  }
  async function fails(statement, role, pattern) {
    await assert.rejects(
      sql(statement, role),
      (error) => pattern.test(`${error.stderr ?? ""}\n${error.message}`),
    );
  }
  async function call(functionName, args, role = "service_role") {
    return JSON.parse(await sql(
      `select to_jsonb(public.${functionName}(${args.join(",")}))::text`,
      role,
    ));
  }

  await sql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);
  await exec("psql", [...connection, "-f", migration], {
    env: poisonedEnvironment,
    maxBuffer: 4 * 1024 * 1024,
  });

  await t.test("migration metadata has explicit hardened privileges", async () => {
    const functions = [
      "begin_usda_source_release(jsonb)",
      "import_usda_source_food_batch(text,jsonb)",
      "complete_usda_source_release(text)",
    ];
    for (const name of functions) {
      assert.equal(await sql(`
        select p.prosecdef
          and p.proconfig @> array['search_path=public, pg_temp']
          and has_function_privilege('service_role', 'public.${name}', 'EXECUTE')
          and not has_function_privilege('anon', 'public.${name}', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.${name}', 'EXECUTE')
        from pg_proc p where p.oid = 'public.${name}'::regprocedure
      `), "t");
    }
    assert.equal(await sql(`
      select every(c.reloptions @> array['security_invoker=true'])
      from pg_class c
      where c.oid in ('public.usda_source_nutrients'::regclass, 'public.usda_source_portions'::regclass)
    `), "t");
    assert.equal(await sql(`
      select has_table_privilege('service_role', 'public.usda_source_foods', 'SELECT')
        and not has_table_privilege('service_role', 'public.usda_source_foods', 'INSERT,UPDATE,DELETE')
        and has_table_privilege('service_role', 'public.usda_source_nutrients', 'SELECT')
        and not has_table_privilege('anon', 'public.usda_source_foods', 'SELECT')
        and not has_table_privilege('authenticated', 'public.usda_source_foods', 'SELECT')
    `), "t");
  });

  const generous = manifest("sr-legacy-conflict-2026", "conflict-2026", {
    foods: 10,
    nutrients: 0,
    portions: 0,
  });
  const original = food(101, {
    description: "Original 'quoted' café 食品",
    provenance: { nested: [{ quote: '"yes"', unicode: "crème 🥑" }] },
  });

  await t.test("loading imports are hidden and failed batches are atomic", async () => {
    assert.equal(await call("begin_usda_source_release", [encodedJson(generous)]), "loading");
    await fails(
      `select public.begin_usda_source_release(${encodedJson({ ...generous, bytes: 123457 })})`,
      "service_role",
      /manifest differs/,
    );
    await fails(
      `select public.import_usda_source_food_batch('${generous.id}', ${encodedJson([
        food(201, { dataType: "Survey (FNDDS)" }),
      ])})`,
      "service_role",
      /dataset or identifier is invalid/,
    );
    await fails(
      `select public.import_usda_source_food_batch('${generous.id}', ${encodedJson([food(201), food(201)])})`,
      "service_role",
      /Duplicate USDA identifiers/,
    );

    assert.deepEqual(
      await call("import_usda_source_food_batch", [`'${generous.id}'`, encodedJson([original])]),
      { verified: 1, inserted: 1, stored: 1 },
    );
    assert.equal(await sql("select count(*) from public.usda_source_nutrients"), "0");
    assert.equal(await sql("select count(*) from public.usda_source_portions"), "0");
    await fails(
      `select public.complete_usda_source_release('${generous.id}')`,
      "service_role",
      /incomplete or count checks differ/,
    );
    assert.equal(await sql(`select status from public.usda_source_releases where id='${generous.id}'`), "loading");

    assert.deepEqual(
      await call("import_usda_source_food_batch", [`'${generous.id}'`, encodedJson([original])]),
      { verified: 1, inserted: 0, stored: 1 },
    );
    const mutated = { ...original, provenance: { nested: [{ changed: true }] } };
    await fails(
      `select public.import_usda_source_food_batch('${generous.id}', ${encodedJson([mutated, food(202)])})`,
      "service_role",
      /record differs from stored snapshot/,
    );
    assert.equal(
      await sql(`select count(*) from public.usda_source_foods where release_id='${generous.id}'`),
      "1",
    );
  });

  const release = manifest("sr-legacy-small-2026", "small-2026", {
    foods: 2,
    nutrients: 2,
    portions: 1,
  });
  const richFood = food(101, {
    description: `Chef's "Crème brûlée" — 食品 🥑`,
    foodNutrients: [
      {
        nutrient: { id: 1008, name: "Energy \"exact\"", unitName: "kcal" },
        amount: 0,
        derivation: { code: "ZERO", details: ["quoted", { unicode: "naïve" }] },
      },
      {
        nutrient: { id: 1003, name: "Protein", unitName: "g" },
        note: { amountWas: "missing", nested: [null, false, "雪"] },
      },
    ],
    foodPortions: [{
      portionDescription: `1 chef's "cup"`,
      modifier: "cup, quoted",
      measureUnit: { name: "cup", abbreviation: "c" },
      amount: 0,
      gramWeight: 0,
      nested: { preserve: ["all", { fields: true }] },
    }],
  });
  const noPortions = food(102, {
    description: "No nutrients or portions — zéro",
    extra: { arrays: [[], [{ literal: "\\quoted\\ path" }]] },
  });

  await t.test("completion preserves exact JSON, zeroes, missing values, and release identity", async () => {
    assert.equal(await call("begin_usda_source_release", [encodedJson(release)]), "loading");
    assert.deepEqual(
      await call("import_usda_source_food_batch", [`'${release.id}'`, encodedJson([richFood, noPortions])]),
      { verified: 2, inserted: 2, stored: 2 },
    );
    assert.deepEqual(
      await call("complete_usda_source_release", [`'${release.id}'`]),
      { id: release.id, status: "ready", foods: 2, nutrients: 2, portions: 1 },
    );
    assert.deepEqual(
      JSON.parse(await sql(`
        select jsonb_agg(raw_food order by fdc_id)::text
        from public.usda_source_foods where release_id='${release.id}'
      `)),
      [richFood, noPortions],
    );
    assert.deepEqual(JSON.parse(await sql(`
      select jsonb_build_object(
        'nutrients', jsonb_agg(jsonb_build_object(
          'amount', amount, 'raw', raw_nutrient, 'position', position
        ) order by position),
        'portions', (select jsonb_agg(jsonb_build_object(
          'amount', amount, 'grams', gram_weight, 'raw', raw_portion
        ) order by position) from public.usda_source_portions where release_id='${release.id}')
      )::text
      from public.usda_source_nutrients where release_id='${release.id}'
    `)), {
      nutrients: [
        { amount: 0, raw: richFood.foodNutrients[0], position: 1 },
        { amount: null, raw: richFood.foodNutrients[1], position: 2 },
      ],
      portions: [{ amount: 0, grams: 0, raw: richFood.foodPortions[0] }],
    });
    assert.deepEqual(
      await call("import_usda_source_food_batch", [`'${release.id}'`, encodedJson([richFood])]),
      { verified: 1, inserted: 0, stored: 2 },
    );
    await fails(
      `select public.import_usda_source_food_batch('${release.id}', ${encodedJson([food(103)])})`,
      "service_role",
      /Cannot append records/,
    );
    assert.equal(await sql(`
      select count(*) from public.usda_source_foods
      where fdc_id=101 and release_id in ('${generous.id}', '${release.id}')
    `), "2");
  });

  await t.test("database roles enforce real read, write, and execute denials", async () => {
    for (const role of ["anon", "authenticated"]) {
      await fails("select * from public.usda_source_foods limit 1", role, /permission denied/);
      await fails(
        `insert into public.usda_source_foods(release_id,fdc_id,description,raw_food)
         values ('${release.id}',999,'x',${encodedJson(food(999))})`,
        role,
        /permission denied/,
      );
      await fails(
        `select public.begin_usda_source_release(${encodedJson(manifest(
          `denied-${role}-2026`,
          `denied-${role}`,
          { foods: 1, nutrients: 0, portions: 0 },
        ))})`,
        role,
        /permission denied/,
      );
    }
    await fails(
      `insert into public.usda_source_foods(release_id,fdc_id,description,raw_food)
       values ('${release.id}',998,'x',${encodedJson(food(998))})`,
      "service_role",
      /permission denied/,
    );
    assert.equal(
      await call("begin_usda_source_release", [encodedJson(release)]),
      "ready",
    );
  });
});