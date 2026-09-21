import {beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({admin:vi.fn(),mode:vi.fn(),one:vi.fn(),stripe:vi.fn()}));
vi.mock("../lib/supabase-admin",()=>({supabaseAdmin:m.admin}));
vi.mock("./mode-state",()=>({getBillingModeStatus:m.mode}));
vi.mock("./store",()=>({selectOne:m.one}));
vi.mock("./stripe-client",()=>({getStripe:m.stripe,connectedOpts:(id:string)=>({stripeAccount:id})}));
import {connectGuard,restartConnect} from "./connect-guard";
import {runWithBillingIdentity} from "./stripe-environment";
const identity={mode:"test" as const,platformAccountId:"acct_platform"};
const run=(fn:()=>Promise<unknown>)=>runWithBillingIdentity(identity,fn);
const empty=()=>vi.fn().mockResolvedValue({data:[]});
let stripe:ReturnType<typeof fakeStripe>;
function fakeStripe(){return {accounts:{retrieve:vi.fn().mockResolvedValue({charges_enabled:false,payouts_enabled:false})},
  balance:{retrieve:vi.fn().mockResolvedValue({available:[],pending:[]})},charges:{list:empty()},
  paymentIntents:{list:empty()},subscriptions:{list:empty()},payouts:{list:empty()},balanceTransactions:{list:empty()}};}
beforeEach(()=>{
  vi.clearAllMocks();process.env.BILLING_DEPLOYMENT_ID="deploy";
  m.mode.mockResolvedValue({...identity,version:1});
  m.admin.mockResolvedValue({status:200,json:{generation:2,token:"claim"}});
  m.one.mockResolvedValue({stripe_account_id:"acct_office"});
  stripe=fakeStripe();m.stripe.mockResolvedValue(stripe);
});
describe("safe Connect restart",()=>{
  it("archives via claimed RPC without any remote mutation",async()=>{
    await run(()=>restartConnect("office"));
    expect(m.admin.mock.calls.map(c=>c[2].p_action)).toEqual(["restart_claim","restart_commit"]);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith("acct_office");
  });
  it.each(["charges_enabled","payouts_enabled"])("blocks %s even when other capability is false",async field=>{
    stripe.accounts.retrieve.mockResolvedValue({charges_enabled:false,payouts_enabled:false,[field]:true});
    await expect(run(()=>restartConnect("office"))).rejects.toThrow("already enabled");
    expect(m.admin.mock.calls.map(c=>c[2].p_action)).toEqual(["restart_claim","release"]);
  });
  it.each(["charges","paymentIntents","subscriptions","payouts","balanceTransactions"] as const)("blocks remote %s history",async resource=>{
    stripe[resource].list.mockResolvedValue({data:[{id:"history"}]});
    await expect(run(()=>restartConnect("office"))).rejects.toThrow("Financial activity");
    expect(m.admin.mock.calls.some(c=>c[2].p_action==="restart_commit")).toBe(false);
  });
  it("blocks nonzero balances and fails closed on Stripe outage",async()=>{
    stripe.balance.retrieve.mockResolvedValue({available:[{amount:1}],pending:[]});
    await expect(run(()=>restartConnect("office"))).rejects.toThrow("Financial activity");
    stripe.balance.retrieve.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(run(()=>restartConnect("office"))).rejects.toThrow("Stripe unavailable");
  });
  it("blocks stale billing identity before claim/remote work",async()=>{
    m.mode.mockResolvedValue({mode:"live",platformAccountId:"acct_platform",version:2});
    await expect(run(()=>restartConnect("office"))).rejects.toThrow("mode changed");
    expect(m.admin).not.toHaveBeenCalled();expect(m.stripe).not.toHaveBeenCalled();
  });
  it("fails closed on local financial/concurrency guard refusal",async()=>{
    m.admin.mockResolvedValue({status:409,json:{message:"Financial records exist"}});
    await expect(run(()=>restartConnect("office"))).rejects.toThrow("Financial records");
    expect(m.stripe).not.toHaveBeenCalled();
  });
  it("passes generation/token to guarded attachment and preserves database refusal",async()=>{
    m.admin.mockResolvedValue({status:409,json:{message:"Stale connection operation"}});
    await expect(run(()=>connectGuard("attach","office",{p_generation:0,p_token:"old"}))).rejects.toThrow("Stale");
  });
});