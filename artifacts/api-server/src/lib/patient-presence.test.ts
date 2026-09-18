import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: mocks.admin,
  fetchAuthUser: vi.fn(),
}));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

import { createPresenceThrottle, notePatientPresence, touchPatientPresence } from "./patient-presence";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("presence throttle", () => {
  it("lets one write through per window and re-opens after it", () => {
    const throttle = createPresenceThrottle(180_000);
    expect(throttle.claim("p1", 1_000)).toBe(true);
    expect(throttle.claim("p1", 2_000)).toBe(false);
    expect(throttle.claim("p1", 180_999)).toBe(false);
    expect(throttle.claim("p2", 2_000)).toBe(true);
    expect(throttle.claim("p1", 181_000)).toBe(true);
  });

  it("releases a slot so a failed write is retried on the next request", () => {
    const throttle = createPresenceThrottle(180_000);
    expect(throttle.claim("p1", 1_000)).toBe(true);
    throttle.release("p1");
    expect(throttle.claim("p1", 1_001)).toBe(true);
  });

  it("sweeps expired entries so idle patients fall out of memory", () => {
    const throttle = createPresenceThrottle(1_000);
    for (let i = 0; i < 499; i += 1) throttle.claim(`p${i}`, 0);
    expect(throttle.size()).toBe(499);
    throttle.claim("late", 5_000); // 500th claim triggers the sweep
    expect(throttle.size()).toBe(1);
  });
});

describe("notePatientPresence", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.warn.mockReset();
  });

  it("writes once per window with the declared platform and never awaits the write", async () => {
    const touch = vi.fn().mockResolvedValue({});
    const throttle = createPresenceThrottle(180_000);
    let now = 10_000;
    const headers = { "x-thinnr-platform": "android", authorization: "Bearer x" };
    expect(notePatientPresence("p1", headers, { throttle, touch, now: () => now })).toBe(true);
    expect(notePatientPresence("p1", headers, { throttle, touch, now: () => now })).toBe(false);
    now += 200_000;
    expect(notePatientPresence("p1", {}, { throttle, touch, now: () => now })).toBe(true);
    expect(touch.mock.calls).toEqual([
      ["p1", "android"],
      ["p1", "unknown"],
    ]);
  });

  it("swallows a failed write, logs it, and frees the slot for the next request", async () => {
    const touch = vi.fn().mockRejectedValue(new Error("down"));
    const throttle = createPresenceThrottle(180_000);
    expect(notePatientPresence("p1", {}, { throttle, touch, now: () => 1 })).toBe(true);
    await flush();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(notePatientPresence("p1", {}, { throttle, touch, now: () => 2 })).toBe(true);
  });
});

describe("touchPatientPresence", () => {
  beforeEach(() => mocks.admin.mockReset());

  it("calls the touch RPC and maps the local day", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ local_day: "2026-09-18", first_touch_today: true }] });
    await expect(touchPatientPresence("p1", "ios")).resolves.toEqual({ localDay: "2026-09-18", firstTouchToday: true });
    expect(mocks.admin).toHaveBeenCalledWith("POST", "/rest/v1/rpc/patient_app_presence_touch", {
      p_patient_id: "p1",
      p_platform: "ios",
    });
  });

  it("throws on a non-2xx or empty RPC answer", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 500, json: { message: "boom" } });
    await expect(touchPatientPresence("p1", "ios")).rejects.toThrow(/presence touch failed \(500\)/);
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [] });
    await expect(touchPatientPresence("p1", "ios")).rejects.toThrow(/presence touch failed/);
  });
});
