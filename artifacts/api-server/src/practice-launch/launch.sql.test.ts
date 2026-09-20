import { afterAll,beforeAll,describe,it,expect } from "vitest";
import { execFileSync,spawnSync } from "node:child_process";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const available=spawnSync("sh",["-c","command -v initdb && command -v psql"],{stdio:"ignore"}).status===0;
let dir="";
const port=58000+process.pid%1000;
function sql(value:string) {
  return execFileSync("psql",["-h",dir,"-p",String(port),"-U","postgres","-d","postgres","-X","-q","-At","-v","ON_ERROR_STOP=1","-c",value],{encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
}
const details={officeName:"Test Office",providerName:"Test Owner",email:"owner@example.com",phone:"(555) 555-0123",address1:"1 Test Street",address2:"",city:"Test",state:"MA",postalCode:"02108"};
const save=(version:number,data=details)=>sql(`select save_practice_launch_details('new',${version},'${JSON.stringify(data)}')`);
describe.skipIf(!available)("practice launch rollout and atomic persistence",()=>{
  beforeAll(()=>{
    dir=mkdtempSync(path.join(tmpdir(),"practice-launch-"));
    execFileSync("initdb",["-D",`${dir}/data`,"-U","postgres","--auth=trust"],{stdio:"ignore"});
    execFileSync("pg_ctl",["-D",`${dir}/data`,"-w","-o",`-k ${dir} -p ${port} -c listen_addresses=''`,"-l",`${dir}/log`,"start"],{stdio:"ignore"});
    sql(`create role anon;create role authenticated;create role service_role;
      create table providers(provider_id text primary key,office_name text,provider_name text,email text,phone text,address_line_1 text,address_line_2 text,city text,state text,postal_code text);
      insert into providers(provider_id) values('legacy');`);
    sql(readFileSync(new URL("../../../../supabase/migrations/20261113000000_practice_launch.sql",import.meta.url),"utf8"));
    sql("insert into providers(provider_id) values('new')");
  },60000);
  afterAll(()=>{if(dir){spawnSync("pg_ctl",["-D",`${dir}/data`,"-m","immediate","stop"],{stdio:"ignore"});rmSync(dir,{recursive:true,force:true});}});
  it("grandfathers all pre-rollout offices and requires only new inserts",()=>{
    expect(sql("select required from practice_launch where provider_id='legacy'")).toBe("f");
    expect(sql("select required from practice_launch where provider_id='new'")).toBe("t");
  });
  it("saves details and checklist together, retries identical values safely",()=>{
    save(0);save(0);
    expect(sql("select version||':'||details_confirmed from practice_launch where provider_id='new'")).toBe("1:true");
    expect(sql("select office_name from providers where provider_id='new'")).toBe("Test Office");
    expect(()=>save(0,{...details,officeName:"Stale"})).toThrow();
    expect(sql("select office_name from providers where provider_id='new'")).toBe("Test Office");
  });
  it("cannot complete partial setup; completion is idempotent",()=>{
    expect(()=>sql("select complete_practice_launch('new',1)")).toThrow();
    expect(sql("select completed_at is null from practice_launch where provider_id='new'")).toBe("t");
    sql("update practice_launch set products_confirmed=true where provider_id='new'");
    sql("select complete_practice_launch('new',1)");
    sql("select complete_practice_launch('new',1)");
    expect(sql("select version from practice_launch where provider_id='new'")).toBe("2");
  });
  it("isolates progress by staff and denies direct client writes",()=>{
    sql("insert into practice_launch_tours(provider_id,actor_user_id,step,status) values('new','00000000-0000-4000-8000-000000000001',2,'active'),('new','00000000-0000-4000-8000-000000000002',0,'skipped')");
    expect(sql("select count(*) from practice_launch_tours")).toBe("2");
    expect(()=>sql("set role authenticated;update practice_launch set completed_at=now()")).toThrow();
    expect(()=>sql("set role authenticated;select complete_practice_launch('legacy',0)")).toThrow();
  });
  it("requires independent mode consent without resetting details or replaying a completion",()=>{
    sql("create table practice_launch_product_receipts(provider_id text,stripe_mode text,platform_account_id text)");
    sql(readFileSync(new URL("../../../../supabase/migrations/20261113020000_practice_launch_mode_completion.sql",import.meta.url),"utf8"));
    sql("insert into practice_launch_product_receipts values('new','test','acct_test')");
    sql("select complete_practice_launch('new',2,'test','acct_test')");
    sql("select complete_practice_launch('new',2,'test','acct_test')");
    expect(sql("select version||':'||details_confirmed from practice_launch where provider_id='new'")).toBe("3:true");
    expect(()=>sql("select complete_practice_launch('new',3,'live','acct_live')")).toThrow();
    sql("insert into practice_launch_product_receipts values('new','live','acct_live')");
    sql("select complete_practice_launch('new',3,'live','acct_live')");
    expect(sql("select count(*) from practice_launch_completions")).toBe("2");
    expect(()=>sql("set role authenticated;select complete_practice_launch('new',4,'live','acct_live')")).toThrow();
  });
});