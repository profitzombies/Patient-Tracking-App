import express from "express";
import type http from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({resolve:vi.fn(),restart:vi.fn()}));
vi.mock("../auth/office-scope",()=>({resolveOfficeScope:m.resolve}));
vi.mock("../billing/connect-guard",()=>({restartConnect:m.restart,ConnectGuardError:class extends Error {constructor(message:string,readonly status=409){super(message);}}}));
import router from "./billing-office";
import {runWithBillingIdentity} from "../billing/stripe-environment";
let server:http.Server,base:string;
beforeAll(async()=>{
  const app=express();app.use(express.json());
  app.use((_req,_res,next)=>runWithBillingIdentity({mode:"test",platformAccountId:"acct_platform"},next));app.use(router);
  server=app.listen(0);await new Promise<void>(resolve=>server.once("listening",resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(()=>server.close());
beforeEach(()=>{vi.clearAllMocks();m.resolve.mockResolvedValue({kind:"ok",scope:{actorKind:"provider",providerId:"owner-office"}});m.restart.mockResolvedValue(undefined);});
const call=(body:unknown={},scope:string|null="test:acct_platform")=>fetch(`${base}/billing/office/connect/restart?office=someone-else`,{
  method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer owner",...(scope?{"X-Billing-Scope":scope}:{})},body:JSON.stringify(body),
});
describe("restart request boundary",()=>{
  it("uses authenticated owner's resolved office, not query office",async()=>{
    const result=await call();expect(result.status).toBe(200);expect(await result.json()).toEqual({restarted:true});
    expect(m.restart).toHaveBeenCalledWith("owner-office");
  });
  it.each(["team_member","hq"])("denies %s even with billing management permissions",async actorKind=>{
    m.resolve.mockResolvedValue({kind:"ok",scope:{actorKind,providerId:"office",officeRole:"admin"}});
    expect((await call()).status).toBe(403);expect(m.restart).not.toHaveBeenCalled();
  });
  it.each([null,"live:acct_platform","test:acct_other"])("fails closed for billing scope %s",async scope=>{
    expect((await call({},scope)).status).toBe(409);expect(m.restart).not.toHaveBeenCalled();
  });
  it("rejects force and client office overrides",async()=>{
    expect((await call({force:true})).status).toBe(400);
    expect((await call({office:"someone-else"})).status).toBe(400);expect(m.restart).not.toHaveBeenCalled();
  });
});