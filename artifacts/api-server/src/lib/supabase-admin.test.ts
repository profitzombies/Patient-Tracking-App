import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyAdminCall,
  READ_ONLY_RPCS,
  setAdminReadRetryDelayForTests,
  supabaseAdmin,
} from "./supabase-admin";
import { currentRequestFlags, runWithRequestFlags } from "./request-context";

function reply(status: number, body: unknown = null): Response {
  return new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("classifyAdminCall", () => {
  it("treats GET and HEAD as reads and every other verb as a write", () => {
    expect(classifyAdminCall("GET", "/rest/v1/patients?select=id")).toBe("read");
    expect(classifyAdminCall("head", "/rest/v1/patients")).toBe("read");
    expect(classifyAdminCall("PATCH", "/rest/v1/patients?id=eq.1")).toBe("write");
    expect(classifyAdminCall("DELETE", "/rest/v1/patients?id=eq.1")).toBe("write");
    expect(classifyAdminCall("PUT", "/rest/v1/patients")).toBe("write");
    expect(classifyAdminCall("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key")).toBe("write");
  });

  it("only allow-listed RPCs count as reads", () => {
    expect(classifyAdminCall("POST", "/rest/v1/rpc/hq_slow_statements")).toBe("read");
    expect(classifyAdminCall("POST", "/rest/v1/rpc/hq_request_latency?select=*")).toBe("read");
    expect(classifyAdminCall("POST", "/rest/v1/rpc/claim_due_jobs")).toBe("write");
    expect(classifyAdminCall("POST", "/rest/v1/rpc/coach_usage_reserve")).toBe("write");
    expect(READ_ONLY_RPCS.has("claim_due_jobs")).toBe(false);
  });

  it("lets a caller pin the kind explicitly", () => {
    expect(classifyAdminCall("POST", "/rest/v1/rpc/some_pure_lookup", { kind: "read" })).toBe("read");
    expect(classifyAdminCall("GET", "/rest/v1/side_effect_view", { kind: "write" })).toBe("write");
  });
});

describe("supabaseAdmin retries", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const delays: number[] = [];

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    fetchMock.mockReset();
    delays.length = 0;
    vi.stubGlobal("fetch", fetchMock);
    setAdminReadRetryDelayForTests(async (ms) => {
      delays.push(ms);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAdminReadRetryDelayForTests(null);
  });

  it("retries a GET once with jitter after a 503", async () => {
    fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, [{ id: 1 }]));
    const result = await supabaseAdmin("GET", "/rest/v1/patients?select=id");
    expect(result.status).toBe(200);
    expect(result.json).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(300);
  });

  it("retries a GET once after a timeout, then surfaces the second failure", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);
    await expect(supabaseAdmin("GET", "/rest/v1/patients")).rejects.toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a GET on a non-transient status or error", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, { message: "boom" }));
    expect((await supabaseAdmin("GET", "/rest/v1/patients")).status).toBe(500);
    fetchMock.mockResolvedValueOnce(reply(404));
    expect((await supabaseAdmin("GET", "/rest/v1/patients")).status).toBe(404);
    fetchMock.mockRejectedValueOnce(new RangeError("bad input"));
    await expect(supabaseAdmin("GET", "/rest/v1/patients")).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(0);
  });

  it("retries an allow-listed read RPC but never a mutating RPC", async () => {
    fetchMock.mockResolvedValueOnce(reply(502)).mockResolvedValueOnce(reply(200, []));
    expect((await supabaseAdmin("POST", "/rest/v1/rpc/hq_slow_statements", { p_limit: 5 })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(504));
    expect((await supabaseAdmin("POST", "/rest/v1/rpc/claim_due_jobs", { p_owner: "x" })).status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("never retries a %s write on a transient status or timeout", async (method) => {
    fetchMock.mockResolvedValueOnce(reply(503));
    const result = await supabaseAdmin(method, "/rest/v1/staff_notifications?id=eq.1", { status: "sent" }, "return=minimal");
    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(supabaseAdmin(method, "/rest/v1/staff_notifications", { a: 1 })).rejects.toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(0);
  });

  it("sends the same request body and headers on the retry", async () => {
    fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, []));
    await supabaseAdmin("POST", "/rest/v1/rpc/hq_request_latency", { p_since: "2026-09-18T00:00:00Z" });
    const [first, second] = fetchMock.mock.calls;
    expect(first?.[0]).toBe("https://example.supabase.co/rest/v1/rpc/hq_request_latency");
    expect(second?.[0]).toBe(first?.[0]);
    expect((second?.[1] as RequestInit).body).toBe((first?.[1] as RequestInit).body);
    expect((second?.[1] as RequestInit).method).toBe("POST");
  });

  it("marks the current request as database-backed", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await runWithRequestFlags({ db: false, ai: false }, async () => {
      await supabaseAdmin("GET", "/rest/v1/patients");
      expect(currentRequestFlags()).toEqual({ db: true, ai: false });
    });
    expect(currentRequestFlags()).toBeNull();
  });
});
