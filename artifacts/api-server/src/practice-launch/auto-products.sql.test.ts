import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// New offices get the suggested prices saved for them. This proves, on real
// PostgreSQL, that the write is atomic, never overwrites a price the office
// already holds, and only ever applies to first-time full setup.
const available = ["initdb", "pg_ctl", "psql"].every(x => spawnSync(x, ["--version"]).status === 0);
let dir = "";
const port = 58000 + process.pid % 1000;
function sql(value: string) {
  return execFileSync("psql", ["-h",dir,"-p",String(port),"-U","postgres","-d","postgres","-X","-q","-At","-v","ON_ERROR_STOP=1","-c",value],
    { encoding:"utf8", stdio:["pipe","pipe","pipe"] }).trim();
}
const actor = "00000000-0000-4000-8000-0000000000aa";
const ids = ["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"];
const suggested = ids.map(productId => ({ productId, enabled:true, sellPriceCents:7198, subscriptionEnabled:true }));
function auto(office: string, products: unknown = suggested, mode = "test", platform = "acct_platform") {
  return JSON.parse(sql(`select autoconfirm_practice_launch_products('${office}','${actor}','${JSON.stringify(products)}','${mode}','${platform}')`));
}
const migration = (name: string) => readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

describe.skipIf(!available)("automatic suggested launch prices on PostgreSQL", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "practice-auto-products-"));
    execFileSync("initdb", ["-D",`${dir}/data`,"-U","postgres","--auth=trust"], {stdio:"ignore"});
    execFileSync("pg_ctl", ["-D",`${dir}/data`,"-w","-o",`-k ${dir} -p ${port} -c listen_addresses=''`,"-l",`${dir}/log`,"start"], {stdio:"ignore"});
    sql(`create role anon; create role authenticated; create role service_role;
      create table providers(provider_id text primary key);
      create table practice_launch(provider_id text primary key, required bool default true, version int default 0, products_confirmed bool default false);
      create table billing_products(id uuid primary key, active bool, floor_price_cents int);
      create table billing_settings(id int primary key, card_fee_bps int,card_fee_fixed_cents int,
        shipping_charge_cents int,subscribe_save_enabled bool,subscribe_save_percent int);
      create table billing_office_prices(provider_id text,product_id uuid,sell_price_cents int,
        subscription_enabled bool,updated_by uuid,stripe_mode text,stripe_platform_account_id text,updated_at timestamptz,
        primary key(provider_id,product_id,stripe_mode,stripe_platform_account_id));
      insert into providers values('new'),('priced'),('legacy'),('cheap');
      insert into practice_launch(provider_id) values('new'),('priced'),('cheap');
      insert into practice_launch(provider_id,required) values('legacy',false);
      insert into billing_products values('${ids[0]}',true,5999),('${ids[1]}',true,5999);
      insert into billing_settings values(1,290,30,1000,true,10);`);
    sql(migration("20261113010000_practice_launch_products.sql"));
    sql(migration("20261128000000_practice_launch_auto_products.sql"));
  }, 60000);
  afterAll(() => {
    if (dir) { spawnSync("pg_ctl", ["-D",`${dir}/data`,"-m","immediate","stop"], {stdio:"ignore"}); rmSync(dir, {recursive:true,force:true}); }
  });

  it("saves every suggested price and confirms products in one commit", () => {
    expect(auto("new")).toEqual({ applied:true, version:1 });
    expect(sql("select version||':'||products_confirmed from practice_launch where provider_id='new'")).toBe("1:true");
    expect(sql("select count(*)||':'||min(sell_price_cents) from billing_office_prices where provider_id='new'")).toBe("2:7198");
    expect(sql("select expected_version||':'||stripe_mode from practice_launch_product_receipts where provider_id='new'")).toBe("0:test");
  });

  it("is a no-op once this payment identity holds a receipt", () => {
    expect(auto("new", suggested.map(p => ({ ...p, sellPriceCents:9000 })))).toEqual({ applied:false, version:1 });
    expect(sql("select max(sell_price_cents) from billing_office_prices where provider_id='new'")).toBe("7198");
  });

  it("never overwrites a price the office already set", () => {
    sql(`insert into billing_office_prices values('priced','${ids[0]}',12345,false,'${actor}','test','acct_platform',now())`);
    auto("priced");
    expect(sql(`select sell_price_cents||':'||subscription_enabled from billing_office_prices where provider_id='priced' and product_id='${ids[0]}'`)).toBe("12345:false");
    expect(sql(`select sell_price_cents from billing_office_prices where provider_id='priced' and product_id='${ids[1]}'`)).toBe("7198");
  });

  it("confirms again in a new payment mode without touching the first mode", () => {
    expect(auto("new", suggested, "live", "acct_live")).toEqual({ applied:true, version:2 });
    expect(sql("select count(*) from billing_office_prices where provider_id='new'")).toBe("4");
    expect(sql("select count(*) from practice_launch_product_receipts where provider_id='new'")).toBe("2");
  });

  it("leaves legacy offices alone", () => {
    expect(auto("legacy")).toEqual({ applied:false, version:0 });
    expect(sql("select count(*) from billing_office_prices where provider_id='legacy'")).toBe("0");
    expect(sql("select products_confirmed from practice_launch where provider_id='legacy'")).toBe("f");
  });

  it("saves an uncovered suggestion switched off instead of failing setup", () => {
    auto("cheap", suggested.map((p, i) => i ? { ...p, sellPriceCents:1 } : p));
    expect(sql(`select enabled||':'||subscription_enabled from billing_office_prices where provider_id='cheap' and product_id='${ids[1]}'`)).toBe("false:false");
    expect(sql("select products_confirmed from practice_launch where provider_id='cheap'")).toBe("t");
  });

  it("rolls back on a catalog mismatch and is unavailable to browser roles", () => {
    sql("insert into providers values('stale'); insert into practice_launch(provider_id) values('stale')");
    expect(() => auto("stale", suggested.slice(0, 1))).toThrow();
    expect(sql("select count(*) from billing_office_prices where provider_id='stale'")).toBe("0");
    expect(sql("select version from practice_launch where provider_id='stale'")).toBe("0");
    expect(sql("select has_function_privilege('authenticated','autoconfirm_practice_launch_products(text,uuid,jsonb,text,text)','EXECUTE')")).toBe("f");
  });
});
