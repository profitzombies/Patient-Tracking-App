import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const available = ["initdb", "pg_ctl", "psql"].every(x => spawnSync(x, ["--version"]).status === 0);
let dir = "";
const port = 57000 + process.pid % 1000;
function sql(value: string) {
  return execFileSync("psql", ["-h",dir,"-p",String(port),"-U","postgres","-d","postgres","-X","-q","-At","-v","ON_ERROR_STOP=1","-c",value],
    { encoding:"utf8", stdio:["pipe","pipe","pipe"] }).trim();
}
const ids = ["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"];
const choices = ids.map((productId, i) => ({ productId, enabled:i === 0, sellPriceCents:5999, subscriptionEnabled:true }));
function save(version: number, products = choices, mode = "test") {
  return sql(`select save_practice_launch_products('office','${ids[0]}',${version},'${JSON.stringify(products)}','${mode}','acct_platform')`);
}
describe.skipIf(!available)("atomic practice product setup on PostgreSQL", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "practice-products-"));
    execFileSync("initdb", ["-D",`${dir}/data`,"-U","postgres","--auth=trust"], {stdio:"ignore"});
    execFileSync("pg_ctl", ["-D",`${dir}/data`,"-w","-o",`-k ${dir} -p ${port} -c listen_addresses=''`,"-l",`${dir}/log`,"start"], {stdio:"ignore"});
    sql(`create role anon; create role authenticated; create role service_role;
      create table providers(provider_id text primary key);
      create table practice_launch(provider_id text primary key, version int default 0, products_confirmed bool default false);
      create table billing_products(id uuid primary key, active bool, floor_price_cents int);
      create table billing_settings(id int primary key, card_fee_bps int,card_fee_fixed_cents int,
        shipping_charge_cents int,subscribe_save_enabled bool,subscribe_save_percent int);
      create table billing_office_prices(provider_id text,product_id uuid,sell_price_cents int,
        subscription_enabled bool,updated_by uuid,stripe_mode text,stripe_platform_account_id text,updated_at timestamptz,
        primary key(provider_id,product_id,stripe_mode,stripe_platform_account_id));
      insert into providers values('office'); insert into practice_launch(provider_id) values('office');
      insert into billing_products values('${ids[0]}',true,5999),('${ids[1]}',true,5999);
      insert into billing_settings values(1,290,30,1000,true,10);`);
    sql(readFileSync(new URL("../../../../supabase/migrations/20261113010000_practice_launch_products.sql", import.meta.url), "utf8"));
  }, 60000);
  afterAll(() => {
    if (dir) { spawnSync("pg_ctl", ["-D",`${dir}/data`,"-m","immediate","stop"], {stdio:"ignore"}); rmSync(dir, {recursive:true,force:true}); }
  });
  it("rolls back the whole batch if a later choice is invalid", () => {
    expect(() => save(0, choices.map((p,i) => i ? {...p,enabled:true,sellPriceCents:1} : p))).toThrow();
    expect(sql("select count(*) from billing_office_prices")).toBe("0");
    expect(sql("select version from practice_launch")).toBe("0");
  });
  it("persists exact cents, disabled choices and checklist in one commit", () => {
    save(0);
    expect(sql("select version||':'||products_confirmed from practice_launch")).toBe("1:true");
    expect(sql(`select enabled||':'||subscription_enabled from billing_office_prices where product_id='${ids[1]}'`)).toBe("false:false");
    expect(sql("select min(sell_price_cents) from billing_office_prices")).toBe("5999");
  });
  it("identical retry is idempotent while competing/stale payloads fail", () => {
    save(0);
    expect(sql("select version from practice_launch")).toBe("1");
    expect(() => save(0, choices.map(p => ({...p,sellPriceCents:8000})))).toThrow();
    expect(() => save(0, choices, "live")).toThrow();
  });
  it("separates live prices and validates discounted minimum", () => {
    expect(() => save(1, choices.map(p => ({...p,enabled:true,sellPriceCents:3900})))).toThrow();
    save(1, choices.map(p => ({...p,sellPriceCents:8000})), "live");
    expect(sql("select count(*) from billing_office_prices")).toBe("4");
    expect(sql("select min(sell_price_cents) from billing_office_prices where stripe_mode='test'")).toBe("5999");
  });
  it("RPC is unavailable to browser roles", () => {
    expect(sql("select has_function_privilege('authenticated','save_practice_launch_products(text,uuid,integer,jsonb,text,text)','EXECUTE')")).toBe("f");
  });
});