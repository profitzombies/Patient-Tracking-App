import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const available = ["initdb","pg_ctl","psql"].every(x => spawnSync(x,["--version"]).status === 0);
let dir = "";
const port = 56000 + process.pid % 1000;
function sql(value: string) {
  return execFileSync("psql", ["-h",dir,"-p",String(port),"-U","postgres","-d","postgres","-X","-q","-At","-v","ON_ERROR_STOP=1","-c",value], {encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
}
describe.skipIf(!available)("billing identity migration on local PostgreSQL", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(),"billing-identity-"));
    execFileSync("initdb",["-D",`${dir}/data`,"-U","postgres","--auth=trust"],{stdio:"ignore"});
    execFileSync("pg_ctl",["-D",`${dir}/data`,"-w","-o",`-k ${dir} -p ${port} -c listen_addresses=''`,"-l",`${dir}/log`,"start"],{stdio:"ignore"});
    sql(`create role anon; create role authenticated; create role service_role;
      create schema auth; create function auth.role() returns text language sql as $$select 'service_role'::text$$;`);
    const generic = ["account_events","office_prices","payment_links","payers","order_items","subscriptions","disputes","payouts","webhook_endpoints","webhook_events","carts","customer_emails","prebuilt_carts","warehouse_sync_polls"];
    for (const table of generic) sql(`create table billing_${table}(id uuid primary key default gen_random_uuid())`);
    sql(`alter table billing_payers add provider_id text, add patient_id uuid;
      create schema private;
      create table patients(id uuid primary key);
      create table billing_settings(id integer primary key);
      create function billing_touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
      create table billing_connected_accounts(provider_id text primary key,stripe_account_id text unique);
      create table billing_orders(id uuid primary key default gen_random_uuid(),provider_id text,patient_id uuid,status text,total_cents integer,paid_at timestamptz,created_at timestamptz default now(),stripe_invoice_id text);
      create table billing_refunds(id uuid primary key default gen_random_uuid(),order_id uuid references billing_orders(id),amount_cents integer,status text);
      create table billing_ledger(id uuid primary key default gen_random_uuid(),kind text,stripe_ref text);
      create table billing_shipments(id uuid primary key default gen_random_uuid(),order_id uuid unique references billing_orders(id),provider_id text,status text);
      insert into billing_connected_accounts values('legacy','acct_legacy');
      insert into patients values('00000000-0000-4000-8000-000000000002');`);
    sql(readFileSync(path.resolve(process.cwd(),"../../supabase/migrations/20261104000000_warehouse_submissions.sql"),"utf8"));
    sql(readFileSync(path.resolve(process.cwd(),"../../supabase/migrations/20261112000000_billing_mode_isolation.sql"),"utf8"));
    sql(readFileSync(path.resolve(process.cwd(),"../../supabase/migrations/20261112010000_billing_warehouse_provider_text.sql"),"utf8"));
    sql("create trigger billing_order_create_shipment after insert on billing_orders for each row execute function billing_order_create_shipment()");
  }, 60000);
  afterAll(() => {
    if (dir) { spawnSync("pg_ctl",["-D",`${dir}/data`,"-m","immediate","stop"]); rmSync(dir,{recursive:true,force:true}); }
  });
  it("leaves legacy unknown and allows the same provider in both modes", () => {
    expect(sql("select stripe_mode is null from billing_connected_accounts where provider_id='legacy'")).toBe("t");
    sql("insert into billing_connected_accounts values('office','acct_same','test','acct_platform'),('office','acct_same','live','acct_platform')");
    expect(sql("select count(*) from billing_connected_accounts where provider_id='office'")).toBe("2");
    expect(() => sql("insert into billing_connected_accounts values('office','acct_same','test','acct_platform')")).toThrow();
    expect(() => sql("update billing_connected_accounts set stripe_mode='test',stripe_platform_account_id='acct_platform' where provider_id='legacy'")).toThrow();
  });
  it("rejects cross-mode foreign references and new unknown identities", () => {
    const id = sql("insert into billing_orders(stripe_mode,stripe_platform_account_id) values('test','acct_platform') returning id");
    expect(sql(`select stripe_mode || ':' || stripe_platform_account_id from billing_shipments where order_id='${id}'`)).toBe("test:acct_platform");
    expect(() => sql(`insert into billing_refunds(order_id,stripe_mode,stripe_platform_account_id) values('${id}','live','acct_platform')`)).toThrow();
    expect(() => sql("insert into billing_orders default values")).toThrow();
  });
  it("queues a paid sandbox order for a non-UUID provider without changing its identity", () => {
    const id = sql(`insert into billing_orders(provider_id,status,stripe_mode,stripe_platform_account_id)
      values('office-non-uuid','paid','test','acct_platform') returning id`);
    expect(sql(`select provider_id || ':' || stripe_mode || ':' || stripe_platform_account_id
      from billing_warehouse_submissions where order_id='${id}'`)).toBe("office-non-uuid:test:acct_platform");
    expect(sql(`select count(*) from billing_warehouse_submissions where order_id='${id}'`)).toBe("1");
  });
  it("switches atomically with audit and stale-version rejection", () => {
    const args = "'deploy','live','acct_platform',0,true,'00000000-0000-4000-8000-000000000001','request'";
    expect(sql(`select version from switch_billing_mode(${args})`)).toBe("1");
    expect(() => sql(`select version from switch_billing_mode(${args})`)).toThrow();
    expect(sql("select count(*) from billing_mode_audit")).toBe("1");
  });
  it("separates roster spend by mode and excludes unknown history", () => {
    sql(`insert into billing_orders(provider_id,patient_id,status,total_cents,stripe_mode,stripe_platform_account_id)
      values('office','00000000-0000-4000-8000-000000000002','paid',100,'test','acct_platform'),
      ('office','00000000-0000-4000-8000-000000000002','paid',900,'live','acct_platform')`);
    expect(sql("select paid_cents from billing_office_patient_spend('office','test','acct_platform')")).toBe("100");
    expect(sql("select paid_cents from billing_office_patient_spend('office','live','acct_platform')")).toBe("900");
    expect(sql("select count(*) from billing_office_patient_spend('office','live','acct_other')")).toBe("0");
  });
});