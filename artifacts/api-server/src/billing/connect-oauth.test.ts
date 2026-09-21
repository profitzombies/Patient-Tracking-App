import crypto from "node:crypto";
import {beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({claim:vi.fn(),guard:vi.fn(),stripe:vi.fn()}));
vi.mock("./connect-guard",()=>({claimConnect:m.claim,connectGuard:m.guard}));
vi.mock("./stripe-client",()=>({getStripe:m.stripe}));
import {completeOauth} from "./accounts";
function state(patch:Record<string,unknown>={}) {
  const encoded=Buffer.from(JSON.stringify({provider_id:"office",actor:"owner",exp:Date.now()+100000,
    identity:{mode:"test",platformAccountId:"acct_platform"},generation:3,modeVersion:5,...patch})).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256","synthetic-state-secret").update(encoded).digest("base64url")}`;
}
beforeEach(()=>{vi.clearAllMocks();process.env.SESSION_SECRET="synthetic-state-secret";});
describe("OAuth claims precede token exchange",()=>{
  it.each(["Existing connection cannot be replaced","Stale generation after restart","Payment mode changed","Operation already in progress"])("rejects %s without any Stripe mutation",async message=>{
    m.claim.mockRejectedValue(new Error(message));
    await expect(completeOauth("code",state())).rejects.toThrow(message);
    expect(m.claim).toHaveBeenCalledWith("office",3,5);
    expect(m.stripe).not.toHaveBeenCalled();expect(m.guard).not.toHaveBeenCalled();
  });
  it("rejects pre-restart-era state missing generation/version",async()=>{
    await expect(completeOauth("code",state({generation:undefined,modeVersion:undefined}))).rejects.toThrow("expired");
    expect(m.claim).not.toHaveBeenCalled();
  });
  it("rejects tampering and expiration before any claim",async()=>{
    await expect(completeOauth("code",`${state()}x`)).rejects.toThrow();
    await expect(completeOauth("code",state({exp:1}))).rejects.toThrow();
    expect(m.claim).not.toHaveBeenCalled();
  });
});