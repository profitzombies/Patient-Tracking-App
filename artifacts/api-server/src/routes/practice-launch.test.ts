import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from "vitest";
const m=vi.hoisted(()=>({scope:vi.fn(),admin:vi.fn(),account:vi.fn(),sync:vi.fn(),products:vi.fn(),save:vi.fn(),launch:vi.fn(),completion:vi.fn(),factor:vi.fn(),policy:vi.fn(),mode:vi.fn(),access:vi.fn(),auto:vi.fn()}));
// The office's OWN payment setup with THINNR is a separate surface; this
// suite only cares that the launch snapshot reflects its verdict.
vi.mock("../billing/office-access/setup",()=>({accessGateFacts:m.access}));
vi.mock("../auth/office-scope",()=>({resolveOfficeScope:m.scope}));
vi.mock("../lib/supabase-admin",()=>({supabaseAdmin:m.admin}));
vi.mock("../billing/mode-state",()=>({getBillingModeStatus:m.mode}));
vi.mock("../billing/store",()=>({selectOne:m.account}));
vi.mock("../billing/accounts",()=>({syncAccount:m.sync}));
vi.mock("../practice-launch/products",()=>({autoconfirmLaunchProducts:m.auto,getLaunchProducts:m.products,saveLaunchProducts:m.save,LaunchProductsError:class extends Error {constructor(message:string,readonly status=400){super(message);}}}));
vi.mock("../practice-launch/state",async original=>({...await original<typeof import("../practice-launch/state")>(),readLaunch:m.launch,readModeCompletion:m.completion}));
vi.mock("../auth/second-factor",()=>({currentSecondFactorPolicy:m.policy,loadStaffSecondFactor:m.factor,secondFactorRequiredByPolicy:(p:{allStaff:boolean})=>p.allStaff}));
// Isolate routing from unrelated HQ account router initialization, retaining
// the actual shape and required fields for this endpoint's details contract.
vi.mock("./provider-accounts",async()=>{const {z}=await import("zod");return {AccountInput:z.object({officeName:z.string().min(1),providerName:z.string().min(1),email:z.string().email(),phone:z.string().min(1),address1:z.string().min(1),address2:z.string(),city:z.string().min(1),state:z.string().min(1),postalCode:z.string().min(1)})};});
import router from "./practice-launch";
import { LaunchProductsError } from "../practice-launch/products";
let server:http.Server,base="";
const owner={providerId:"office-a",officeName:"A",providerName:"Owner",actorUserId:"owner-a",actorKind:"provider",officeRole:"owner",teamMemberId:null};
const details={officeName:"A",providerName:"Owner",email:"owner@example.com",phone:"5555550123",address1:"1 Test",address2:"",city:"Test",state:"MA",postalCode:"02108"};
const product={productId:"00000000-0000-4000-8000-000000000001",enabled:true,sellPriceCents:7198,subscriptionEnabled:true};
async function call(method:string,path="",body?:unknown,header:string|null="test:acct_test"){
 return fetch(`${base}/office/launch${path}`,{method,headers:{"Content-Type":"application/json","Authorization":"Bearer synthetic",...(header?{"X-Billing-Scope":header}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}
beforeAll(async()=>{const app=express();app.use(express.json());app.use(router);await new Promise<void>(r=>{server=app.listen(0,()=>r());});base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;});
afterAll(()=>server.close());
beforeEach(()=>{
 vi.clearAllMocks();
 m.scope.mockResolvedValue({kind:"ok",scope:owner});
 m.mode.mockResolvedValue({mode:"test",platformAccountId:"acct_test",version:0});
 m.launch.mockResolvedValue({required:true,version:2,details_confirmed:true,products_confirmed:true,completed_at:null});
 m.completion.mockResolvedValue(undefined);
 m.account.mockResolvedValue({details_submitted:true,charges_enabled:false,payouts_enabled:false,requirements:{disabled_reason:"requirements.pending_verification"}});
 m.sync.mockResolvedValue({});
 m.products.mockResolvedValue([product]);m.save.mockResolvedValue({version:3});m.auto.mockResolvedValue({applied:false,version:2});
 m.policy.mockResolvedValue({allStaff:false});m.factor.mockResolvedValue(null);
 m.access.mockResolvedValue({satisfied:true,planSelected:true,disclosureAcknowledged:true,status:{missing:[],bankVerificationPending:false,bankVerificationDeadline:null,bankVerificationOverdue:false}});
 m.admin.mockImplementation(async(method:string,path:string)=>{
   if(path.includes("practice_launch_product_receipts")) return {status:200,json:[{expected_version:1}]};
   if(path.includes("/providers?")) return {status:200,json:[{office_name:"A",provider_name:"Owner",email:"owner@example.com"}]};
   return {status:200,json:[]};
 });
});
describe("practice launch HTTP boundary",()=>{
 it("returns server progress and pins scope despite caller office input",async()=>{
   const res=await call("GET","?office=other");
   expect(res.status).toBe(200);expect(await res.json()).toMatchObject({office:{providerId:"office-a"},billingScope:"test:acct_test",payments:{state:"pending"},completedAt:null});
   expect(m.launch).toHaveBeenCalledWith("office-a");
 });
 it.each([401,403,404])("preserves auth/lock/offboarding denial %s",async status=>{
   m.scope.mockResolvedValue({kind:"denied",status,message:"Unavailable"});
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(status);
   expect(m.admin).not.toHaveBeenCalled();expect(m.sync).not.toHaveBeenCalled();
 });
 it.each(["team_member","hq"])("does not let %s consent or modify setup",async actorKind=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind}});
   for(const [path,body] of [["/details",{expectedVersion:2,details}],["/products",{expectedVersion:2,products:[product]}],["/complete",{expectedVersion:2}]] as const){
     expect((await call(path==="/details"?"PUT":"POST",path,body)).status).toBe(403);
   }
   expect(m.save).not.toHaveBeenCalled();expect(m.admin).not.toHaveBeenCalled();
 });
 it("removes the tour route for teammates",async()=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind:"team_member",actorUserId:"staff-a",teamMemberId:"member-a"}});
   expect((await call("PUT","/tour",{step:3,status:"skipped"})).status).toBe(404);
   expect(m.admin).not.toHaveBeenCalled();
   expect(m.admin.mock.calls.some(c=>String(c[1]).includes("/rpc/"))).toBe(false);
 });
 it("rejects HQ tour writes",async()=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind:"hq"}});
   expect((await call("PUT","/tour",{step:0,status:"active"})).status).toBe(404);
 });
 it.each([null,"live:acct_live"])("refuses absent or changed billing identity %s",async header=>{
   expect((await call("POST","/products",{expectedVersion:2,products:[product]},header)).status).toBe(409);
   expect((await call("POST","/complete",{expectedVersion:2},header)).status).toBe(409);
   expect(m.save).not.toHaveBeenCalled();expect(m.sync).not.toHaveBeenCalled();
 });
 it("validates input and maps stale writes without success snapshots",async()=>{
   expect((await call("PUT","/details",{expectedVersion:-1,details})).status).toBe(400);
   m.admin.mockResolvedValue({status:409,json:{code:"40001",message:"Stale version"}});
   expect((await call("PUT","/details",{expectedVersion:1,details})).status).toBe(409);
   m.save.mockRejectedValue(new LaunchProductsError("Stale prices",409));
   expect((await call("POST","/products",{expectedVersion:1,products:[product]})).status).toBe(409);
 });
 it("requires security, current mode product review and actionable Stripe completion",async()=>{
   m.policy.mockResolvedValue({allStaff:true});
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(400);
   m.factor.mockResolvedValue({verifiedAt:"2026-01-01"});
   m.account.mockResolvedValue({details_submitted:true,charges_enabled:false,payouts_enabled:false,requirements:{currently_due:["bank"]}});
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(400);
   expect(m.admin.mock.calls.some(c=>String(c[1]).includes("/rpc/complete"))).toBe(false);
 });
 it("reports the viewer's security facts with only a masked phone",async()=>{
   // Not required for the role and no phone yet: ready, email proven by sign-in.
   expect(((await(await call("GET")).json()) as {security:unknown}).security).toEqual({ready:true,emailVerified:true,phoneVerified:false,phoneRequired:false,phoneMasked:null});
   // Required and not verified yet: the office must add a phone.
   m.policy.mockResolvedValue({allStaff:true});
   expect(((await(await call("GET")).json()) as {security:unknown}).security).toEqual({ready:false,emailVerified:true,phoneVerified:false,phoneRequired:true,phoneMasked:null});
   // Required and verified: ready, and the full number never leaves the API.
   m.factor.mockResolvedValue({kind:"provider",ref:"office-a",phone:"+16175557788",verifiedAt:"2026-01-01T00:00:00Z",enabled:true});
   const raw=await(await call("GET")).text();
   expect(JSON.parse(raw).security).toEqual({ready:true,emailVerified:true,phoneVerified:true,phoneRequired:true,phoneMasked:"(•••) •••-7788"});
   expect(raw).not.toContain("6175557788");
   expect(m.factor).toHaveBeenCalledWith("provider","office-a");
 });
 it("keeps HQ inspection ready without reading the office's phone",async()=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind:"hq"}});
   m.policy.mockResolvedValue({allStaff:true});
   expect(((await(await call("GET")).json()) as {security:unknown}).security).toEqual({ready:true,emailVerified:true,phoneVerified:false,phoneRequired:false,phoneMasked:null});
   expect(m.factor).not.toHaveBeenCalled();
 });
 it("lets setup finish while Stripe is still verifying the account",async()=>{
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(200);
   expect(m.admin).toHaveBeenCalledWith("POST","/rest/v1/rpc/complete_practice_launch",{p_provider_id:"office-a",p_expected_version:2,p_stripe_mode:"test",p_platform_account_id:"acct_test"});
 });
 it("blocks accounts Stripe still needs something from, or has disabled",async()=>{
   m.account.mockResolvedValue({details_submitted:true,charges_enabled:false,payouts_enabled:false,requirements:{currently_due:["external_account"]}});
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(400);
   m.account.mockResolvedValue({details_submitted:true,charges_enabled:false,payouts_enabled:false,requirements:{disabled_reason:"rejected.fraud"}});
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(400);
   expect(m.admin.mock.calls.some(c=>String(c[1]).includes("/rpc/complete"))).toBe(false);
 });
 it("allows ready accounts to submit in the pinned mode",async()=>{
   m.account.mockResolvedValue({details_submitted:true,charges_enabled:true,payouts_enabled:true,requirements:{}});
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(200);
   expect(m.sync).toHaveBeenCalledWith("office-a");
   expect(m.admin).toHaveBeenCalledWith("POST","/rest/v1/rpc/complete_practice_launch",{p_provider_id:"office-a",p_expected_version:2,p_stripe_mode:"test",p_platform_account_id:"acct_test"});
 });
 it("requires legacy offices to confirm Stripe but not details or products",async()=>{
   m.launch.mockResolvedValue({required:false,version:0,details_confirmed:false,products_confirmed:false});
   const pending=await(await call("GET")).json();
   expect(pending).toMatchObject({required:true,fullSetupRequired:false,completedAt:null});
   expect(pending).not.toHaveProperty("tour");
   m.account.mockResolvedValue({details_submitted:false,charges_enabled:false,payouts_enabled:false,requirements:{}});
   expect((await call("POST","/complete",{expectedVersion:0})).status).toBe(400);
   m.account.mockResolvedValue({details_submitted:true,charges_enabled:true,payouts_enabled:true,requirements:{}});
   expect((await call("POST","/complete",{expectedVersion:0})).status).toBe(200);
 });
 it.each(["provider","team_member"])("does not let %s re-gate an office",async actorKind=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind}});
   expect((await call("POST","/regate",{expectedVersion:2})).status).toBe(403);
   expect(m.admin).not.toHaveBeenCalled();
 });
 it("HQ re-gates with provider_manage without modifying Stripe",async()=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind:"hq"}});
   expect((await call("POST","/regate?office=office-a",{expectedVersion:2})).status).toBe(200);
   expect(m.scope).toHaveBeenCalledWith(expect.objectContaining({hqPermission:"provider_manage"}));
   expect(m.admin).toHaveBeenCalledWith("POST","/rest/v1/rpc/regate_practice_launch",expect.objectContaining({p_expected_version:2,p_provider_id:"office-a"}));
   expect(m.sync).not.toHaveBeenCalled();
 });
 it.each(["provider","team_member"])("does not let %s waive its own setup gate",async actorKind=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind}});
   expect((await call("POST","/override",{expectedVersion:2,enabled:true})).status).toBe(403);
   expect(m.admin).not.toHaveBeenCalled();
 });
 it("HQ waives the gate with provider_manage and the snapshot keeps reporting reality",async()=>{
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind:"hq"}});
   m.launch.mockResolvedValue({required:true,version:2,details_confirmed:true,products_confirmed:true,completed_at:null,setup_override_at:"2026-02-01T00:00:00Z",setup_override_note:"Demo account"});
   const res=await call("POST","/override?office=office-a",{expectedVersion:2,enabled:true,note:"Demo account"});
   expect(res.status).toBe(200);
   expect(m.scope).toHaveBeenCalledWith(expect.objectContaining({hqPermission:"provider_manage"}));
   expect(m.admin).toHaveBeenCalledWith("POST","/rest/v1/rpc/set_practice_launch_override",{p_provider_id:"office-a",p_expected_version:2,p_actor:"owner-a",p_enabled:true,p_note:"Demo account"});
   // Waiving opens the workspace; it never claims Stripe or the office's own
   // payment setup is done.
   expect(await res.json()).toMatchObject({completedAt:"2026-02-01T00:00:00Z",setupOverride:{active:true,note:"Demo account"},payments:{state:"pending"}});
   expect(m.sync).not.toHaveBeenCalled();
 });
 it("reports no waiver when HQ has not granted one",async()=>{
   expect(await(await call("GET")).json()).toMatchObject({setupOverride:{active:false,at:null,note:null},completedAt:null});
 });
 it("does not accept another mode's product confirmation or conceal storage failures",async()=>{
   const original=m.admin.getMockImplementation()!;
   m.admin.mockImplementation(async(method:string,path:string,...args:unknown[])=>path.includes("practice_launch_product_receipts") ? {status:200,json:[]} : original(method,path,...args));
   expect((await call("POST","/complete",{expectedVersion:2})).status).toBe(400);
   expect(m.admin.mock.calls.some(c=>String(c[1]).includes("/rpc/complete"))).toBe(false);
   m.admin.mockResolvedValue({status:503,json:{error:"offline"}});
   expect((await call("GET")).status).toBe(503);
 });
 it("re-evaluates mode progress without clearing practice details",async()=>{
   m.mode.mockResolvedValue({mode:"live",platformAccountId:"acct_live",version:1});
   const result=await(await call("GET")).json();
   expect(result).toMatchObject({billingScope:"live:acct_live",detailsConfirmed:true,completedAt:null});
   expect(m.completion).toHaveBeenCalledWith("office-a",expect.objectContaining({mode:"live"}));
 });
 it("saves suggested prices for a new office's first read and reports products confirmed",async()=>{
   const original=m.admin.getMockImplementation()!;
   let saved=false;
   m.launch.mockImplementation(async()=>({required:true,version:saved?3:2,details_confirmed:true,products_confirmed:saved,completed_at:null}));
   m.admin.mockImplementation(async(method:string,path:string,...args:unknown[])=>path.includes("practice_launch_product_receipts") ? {status:200,json:saved?[{expected_version:2}]:[]} : original(method,path,...args));
   m.auto.mockImplementation(async()=>{saved=true;return {applied:true,version:3};});
   const body=await(await call("GET")).json();
   expect(m.auto).toHaveBeenCalledWith("office-a","owner-a");
   expect(body).toMatchObject({productsConfirmed:true,version:3,fullSetupRequired:true});
 });
 it("never writes prices for HQ reads, legacy offices or offices already confirmed",async()=>{
   await call("GET");
   expect(m.auto).not.toHaveBeenCalled();
   m.launch.mockResolvedValue({required:false,version:0,details_confirmed:false,products_confirmed:false});
   await call("GET");
   expect(m.auto).not.toHaveBeenCalled();
   const original=m.admin.getMockImplementation()!;
   m.admin.mockImplementation(async(method:string,path:string,...args:unknown[])=>path.includes("practice_launch_product_receipts") ? {status:200,json:[]} : original(method,path,...args));
   m.launch.mockResolvedValue({required:true,version:2,details_confirmed:true,products_confirmed:false,completed_at:null});
   m.scope.mockResolvedValue({kind:"ok",scope:{...owner,actorKind:"hq"}});
   expect((await(await call("GET","?office=office-a")).json())).toMatchObject({productsConfirmed:false});
   expect(m.auto).not.toHaveBeenCalled();
 });
 it("keeps the read working when the suggested-price write fails",async()=>{
   const original=m.admin.getMockImplementation()!;
   m.admin.mockImplementation(async(method:string,path:string,...args:unknown[])=>path.includes("practice_launch_product_receipts") ? {status:200,json:[]} : original(method,path,...args));
   m.auto.mockRejectedValue(new LaunchProductsError("Catalog changed",409));
   const res=await call("GET");
   expect(res.status).toBe(200);
   expect(await res.json()).toMatchObject({productsConfirmed:false});
 });
});
