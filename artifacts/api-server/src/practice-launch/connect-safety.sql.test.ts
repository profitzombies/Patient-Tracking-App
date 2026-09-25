import { afterAll,beforeAll,describe,it,expect } from "vitest";
import { execFileSync,spawnSync } from "node:child_process";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const available=spawnSync("sh",["-c","command -v initdb && command -v psql"],{stdio:"ignore"}).status===0;
let dir="";
const port=59000+process.pid%1000;
function sql(value:string) {
  return execFileSync("psql",["-h",dir,"-p",String(port),"-U","postgres","-d","postgres","-X","-q","-At","-v","ON_ERROR_STOP=1","-c",value],{encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
}
const token="00000000-0000-4000-8000-000000000001";
const guard=(office:string,action:string,extra="")=>`select guard_office_connect('${office}','test','acct_platform','deploy','${action}'${extra})`;
describe.skipIf(!available)("mandatory launch and safe connection database protections",()=>{
  beforeAll(()=>{
    dir=mkdtempSync(path.join(tmpdir(),"connect-safety-"));
    execFileSync("initdb",["-D",`${dir}/data`,"-U","postgres","--auth=trust"],{stdio:"ignore"});
    execFileSync("pg_ctl",["-D",`${dir}/data`,"-w","-o",`-k ${dir} -p ${port} -c listen_addresses=''`,"-l",`${dir}/log`,"start"],{stdio:"ignore"});
    sql(`create role anon;create role authenticated;create role service_role;
      create table providers(provider_id text primary key);
      create table practice_launch(provider_id text primary key references providers,required boolean default true,version int default 0,details_confirmed boolean default false,products_confirmed boolean default false,completed_at timestamptz);
      create table practice_launch_completions(provider_id text,stripe_mode text,platform_account_id text,completed_at timestamptz default now(),primary key(provider_id,stripe_mode,platform_account_id));
      create table practice_launch_product_receipts(provider_id text,stripe_mode text,platform_account_id text);
      create table billing_mode_state(deployment_id text primary key,mode text,platform_account_id text,version integer default 0);
      create table billing_account_events(provider_id text,kind text);
      insert into billing_mode_state(deployment_id,mode,platform_account_id) values('deploy','test','acct_platform');
      create table billing_connected_accounts(provider_id text,stripe_account_id text, stripe_mode text,stripe_platform_account_id text,
        charges_enabled boolean default false,payouts_enabled boolean default false,details_submitted boolean default false,
        disconnected_at timestamptz,requirements jsonb default '{}',last_synced_at timestamptz,created_at timestamptz,updated_at timestamptz,
        primary key(provider_id,stripe_mode,stripe_platform_account_id));`);
    for(const t of ["orders","subscriptions","ledger","payouts","payers","payment_links","carts","prebuilt_carts"])
      sql(`create table billing_${t}(provider_id text,stripe_mode text,stripe_platform_account_id text)`);
    sql(`insert into providers values('legacy'),('new'),('restart'),('used'),('race'),('mode');
      insert into practice_launch(provider_id,required) select provider_id,provider_id='new' from providers;
      insert into billing_connected_accounts(provider_id,stripe_account_id,stripe_mode,stripe_platform_account_id) select provider_id,'acct_'||provider_id,'test','acct_platform' from providers where provider_id<>'mode';`);
    sql(readFileSync(new URL("../../../../supabase/migrations/20261114000000_mandatory_connect_safe_restart.sql",import.meta.url),"utf8"));
    sql(readFileSync(new URL("../../../../supabase/migrations/20261116010000_connect_guard_implicit_mode_default.sql",import.meta.url),"utf8"));
    sql(readFileSync(new URL("../../../../supabase/migrations/20261127000000_practice_launch_hq_override.sql",import.meta.url),"utf8"));
    sql(readFileSync(new URL("../../../../supabase/migrations/20261128000000_practice_launch_allow_pending_stripe.sql",import.meta.url),"utf8"));
    sql(readFileSync(new URL("../../../../supabase/migrations/20261129000000_practice_launch_allow_submitted_stripe.sql",import.meta.url),"utf8"));
  },60000);
  afterAll(()=>{if(dir){spawnSync("pg_ctl",["-D",`${dir}/data`,"-m","immediate","stop"],{stdio:"ignore"});rmSync(dir,{recursive:true,force:true});}});
  it("legacy cannot complete pending Stripe, but can complete ready without product review",()=>{
    expect(()=>sql("select complete_practice_launch('legacy',0,'test','acct_platform')")).toThrow();
    sql("update billing_connected_accounts set details_submitted=true,charges_enabled=true,payouts_enabled=true,last_synced_at=clock_timestamp() where provider_id in ('legacy','new')");
    sql("select complete_practice_launch('legacy',0,'test','acct_platform')");
    expect(()=>sql("select complete_practice_launch('new',0,'test','acct_platform')")).toThrow();
  });
  it("finishes once Stripe's form is submitted, but never for an unsubmitted, rejected or disconnected account",()=>{
    // Fixture rows skip the connect-identity trigger (session-local replica
    // role): this test is about the completion rule, not how rows get made.
    sql(`set session_replication_role=replica;
      insert into providers values('pend'),('unsubmitted'),('rejected'),('due'),('pastdue'),('review'),('flagged'),('listed'),('gone');
      insert into practice_launch(provider_id,required) values('pend',false),('unsubmitted',false),('rejected',false),('due',false),('pastdue',false),('review',false),('flagged',false),('listed',false),('gone',false);
      insert into billing_connected_accounts(provider_id,stripe_account_id,stripe_mode,stripe_platform_account_id,details_submitted,requirements,last_synced_at) values
        ('pend','acct_pend','test','acct_platform',true,'{"disabled_reason":"requirements.pending_verification","pending_verification":["individual.verification.document"]}',clock_timestamp()),
        ('unsubmitted','acct_unsub','test','acct_platform',false,'{}',clock_timestamp()),
        ('rejected','acct_rej','test','acct_platform',true,'{"disabled_reason":"rejected.fraud"}',clock_timestamp()),
        ('due','acct_due','test','acct_platform',true,'{"currently_due":["external_account"]}',clock_timestamp()),
        ('pastdue','acct_past','test','acct_platform',true,'{"past_due":["business_profile.url"],"disabled_reason":"requirements.past_due"}',clock_timestamp()),
        ('review','acct_review','test','acct_platform',true,'{"disabled_reason":"under_review"}',clock_timestamp()),
        ('listed','acct_listed','test','acct_platform',true,'{"disabled_reason":"listed"}',clock_timestamp());
      insert into billing_connected_accounts(provider_id,stripe_account_id,stripe_mode,stripe_platform_account_id,details_submitted,charges_enabled,payouts_enabled,requirements,last_synced_at,disconnected_at) values
        ('flagged','acct_flag','test','acct_platform',true,true,true,'{"disabled_reason":"rejected.fraud"}',clock_timestamp(),null),
        ('gone','acct_gone','test','acct_platform',true,true,true,'{}',clock_timestamp(),clock_timestamp());`);
    for (const id of ["pend","due","pastdue","review"]) {
      sql(`select complete_practice_launch('${id}',0,'test','acct_platform')`);
      expect(sql(`select count(*) from practice_launch_completions where provider_id='${id}'`)).toBe("1");
    }
    for (const id of ["unsubmitted","rejected","flagged","listed","gone"]) expect(()=>sql(`select complete_practice_launch('${id}',0,'test','acct_platform')`)).toThrow();
  });
  it("re-gate preserves Stripe and requires fresh sync plus versioned reconfirmation",()=>{
    sql(`select regate_practice_launch('legacy',1,'${token}')`);
    expect(sql("select count(*) from practice_launch_completions where provider_id='legacy'")).toBe("0");
    expect(sql("select stripe_account_id from billing_connected_accounts where provider_id='legacy'")).toBe("acct_legacy");
    expect(()=>sql("select complete_practice_launch('legacy',2,'test','acct_platform')")).toThrow();
    sql("update billing_connected_accounts set last_synced_at=clock_timestamp() where provider_id='legacy'");
    expect(()=>sql("select complete_practice_launch('legacy',1,'test','acct_platform')")).toThrow();
    sql("select complete_practice_launch('legacy',2,'test','acct_platform')");
  });
  it("HQ waiver opens the gate, refuses stale callers, and dies when setup is required again",()=>{
    sql("insert into providers values('waived');insert into practice_launch(provider_id,required) values('waived',true)");
    const row=()=>sql("select version||':'||coalesce(setup_override_note,'-')||':'||(setup_override_at is not null) from practice_launch where provider_id='waived'");
    // A caller working from an out-of-date snapshot never lands, even when it
    // asks for the state the row is already in.
    expect(()=>sql(`select set_practice_launch_override('waived',7,'${token}',false,null)`)).toThrow();
    sql(`select set_practice_launch_override('waived',0,'${token}',true,'  Demo account ')`);
    expect(row()).toBe("1:Demo account:true");
    // Repeating the same request from a current snapshot changes nothing.
    sql(`select set_practice_launch_override('waived',1,'${token}',true,'Demo account')`);
    expect(row()).toBe("1:Demo account:true");
    // Requiring setup again must actually close the gate.
    sql(`select regate_practice_launch('waived',1,'${token}')`);
    expect(row()).toBe("2:-:false");
    expect(()=>sql(`set role authenticated;select set_practice_launch_override('waived',2,'${token}',true,null)`)).toThrow();
  });
  it("restart archives identity and invalidates stale callback generations",()=>{
    sql(guard("restart","restart_claim",`,null,'${token}'`));
    sql(guard("restart","restart_commit",`,0,'${token}'`));
    expect(sql("select count(*) from billing_connected_accounts where provider_id='restart'")).toBe("0");
    expect(sql("select account_snapshot->>'stripe_account_id' from billing_connect_archive where provider_id='restart'")).toBe("acct_restart");
    expect(()=>sql(guard("restart","claim",`,0,'${token}'`))).toThrow();
    expect(JSON.parse(sql(guard("restart","start"))).generation).toBe(1);
    sql(guard("restart","claim",`,1,'${token}'`));
    expect(()=>sql(guard("restart","claim",`,1,'${token}'`))).toThrow();
    sql(guard("restart","attach",`,1,'${token}','{"stripe_account_id":"acct_fresh","charges_enabled":false,"payouts_enabled":false,"details_submitted":false,"requirements":{}}'`));
    expect(sql("select stripe_account_id from billing_connected_accounts where provider_id='restart'")).toBe("acct_fresh");
    expect(sql("select count(*) from billing_connect_archive where provider_id='restart'")).toBe("1");
  });
  it("blocks used/ready accounts and active replacement, including direct DB writes",()=>{
    sql("insert into billing_orders values('used','test','acct_platform')");
    expect(()=>sql(guard("used","restart_claim",`,null,'${token}'`))).toThrow();
    expect(()=>sql(guard("legacy","restart_claim",`,null,'${token}'`))).toThrow();
    expect(()=>sql(guard("used","claim",`,0,'${token}'`))).toThrow();
    expect(()=>sql("update billing_connected_accounts set stripe_account_id='acct_replaced' where provider_id='used'")).toThrow();
    expect(()=>sql("delete from billing_connected_accounts where provider_id='used'")).toThrow();
  });
  it("serializes restart against financial writes and competing operations",()=>{
    sql(guard("race","restart_claim",`,null,'${token}'`));
    expect(()=>sql("insert into billing_orders values('race','test','acct_platform')")).toThrow();
    expect(()=>sql(guard("race","restart_claim",`,null,'${token}'`))).toThrow();
    expect(()=>sql("update billing_connected_accounts set charges_enabled=true where provider_id='race'")).toThrow();
    sql(guard("race","release",`,null,'${token}'`));
    sql("insert into billing_payers values('race','test','acct_platform')");
    sql("delete from billing_payers where provider_id='race'");
    expect(()=>sql(guard("race","restart_claim",`,null,'${token}'`))).toThrow();
  });
  it("accepts only the implicit Test/version-0 default while no mode row exists",()=>{
    const fresh=(office:string,action:string,extra="")=>`select guard_office_connect('${office}','test','acct_platform','fresh-deploy','${action}'${extra})`;
    sql("insert into providers values('fresh');insert into practice_launch(provider_id) values('fresh')");
    expect(sql(fresh("fresh","claim",`,0,'${token}'`))).toContain('"modeVersion": 0');
    sql(fresh("fresh","attach",`,0,'${token}','{"stripe_account_id":"acct_fresh"}',0`));
    expect(sql("select stripe_account_id from billing_connected_accounts where provider_id='fresh'")).toBe("acct_fresh");
    expect(()=>sql(`select guard_office_connect('fresh','live','acct_platform','fresh-deploy','start')`)).toThrow();
    expect(()=>sql(`select guard_office_connect('fresh','test','acct_platform','fresh-deploy','start',null,null,null,3)`)).toThrow();
    sql("insert into billing_mode_state(deployment_id,mode,platform_account_id,version) values('fresh-deploy','live','acct_platform',1)");
    expect(()=>sql(fresh("fresh","start"))).toThrow();
  });
  it("blocks mode races and anonymous/service direct mutation",()=>{
    sql(guard("mode","claim",`,0,'${token}'`));
    sql("update billing_mode_state set mode='live'");
    expect(()=>sql(guard("mode","attach",`,0,'${token}','{\"stripe_account_id\":\"acct_new\"}'`))).toThrow();
    sql("update billing_mode_state set mode='test',version=2");
    expect(()=>sql(guard("mode","attach",`,0,'${token}','{\"stripe_account_id\":\"acct_new\"}',0`))).toThrow();
    expect(()=>sql(`set role authenticated;${guard("mode","start")}`)).toThrow();
    expect(()=>sql("set role service_role;update billing_connect_guards set operation_token=null")).toThrow();
  });
});