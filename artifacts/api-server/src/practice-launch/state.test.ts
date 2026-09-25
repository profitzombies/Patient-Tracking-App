import { describe,it,expect } from "vitest";
import { isLaunchAllowedPath,paymentLaunchState } from "./state";
describe("practice launch gates",()=>{
  it("allows recovery and connect routes but not operational deep links",()=>{
    for(const path of ["/api/office/launch","/office/launch/products","/api/security","/api/billing/office/connect/sync","/api/billing/office/status","/api/billing/office/access","/api/billing/office/access/instruments","/api/billing/office/access/pay"]) expect(isLaunchAllowedPath(path)).toBe(true);
    for(const path of ["/api/office/patients","/api/billing/office/sales","/api/office/team","/api/billing/office/orders"]) expect(isLaunchAllowedPath(path)).toBe(false);
  });
  it("does not confuse readiness with actionable or pending requirements",()=>{
    const account={details_submitted:true,charges_enabled:false,payouts_enabled:false,requirements:{}};
    expect(paymentLaunchState(null)).toBe("not_started");
    expect(paymentLaunchState({...account,details_submitted:false})).toBe("action_required");
    expect(paymentLaunchState({...account,requirements:{currently_due:["bank_account"]}})).toBe("action_required");
    expect(paymentLaunchState({...account,requirements:{past_due:["business_profile"]}})).toBe("action_required");
    expect(paymentLaunchState({...account,requirements:{disabled_reason:"rejected.fraud"}})).toBe("action_required");
    expect(paymentLaunchState({...account,requirements:{disabled_reason:"requirements.pending_verification"}})).toBe("pending");
    expect(paymentLaunchState({...account,charges_enabled:true,payouts_enabled:true})).toBe("ready");
    expect(paymentLaunchState({...account,charges_enabled:true,payouts_enabled:true,requirements:{disabled_reason:"rejected.fraud"}})).toBe("action_required");
    expect(paymentLaunchState({...account,requirements:{disabled_reason:""}})).toBe("pending");
  });
});