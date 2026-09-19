/**
 * The shared inbox change feed: polls only while subscribed, re-reads an
 * overlap window without re-emitting rows it already announced, coalesces
 * pokes, and fans in-process notifications out immediately.
 */
import { describe, expect, it, vi } from "vitest";
import { InboxChangeFeed, changedConversationsPath, type InboxChange } from "./inbox-feed";

const row = (id: string, updatedAt: string, providerId = "office-a"): InboxChange => ({
  conversationId: id, patientId: "p1", providerId, thread: "care_team", updatedAt,
});
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

describe("InboxChangeFeed", () => {
  it("names the patient foreign key in its embed so PostgREST never answers 300 (ambiguous)", () => {
    // Conversations also reach `patients` through the read-marker junction
    // table; a bare `patients(...)` embed stalled the live feed on every tick.
    const path = changedConversationsPath("2026-09-19T16:00:00.000Z");
    expect(path).toContain("patients!patient_chat_conversations_patient_id_fkey(provider_id)");
    expect(path).not.toMatch(/[,(]patients\(/);
    expect(path).toContain("updated_at=gt.2026-09-19T16%3A00%3A00.000Z");
  });

  it("does not touch the database until someone subscribes, then stops with the last unsubscribe", async () => {
    const fetchChanges = vi.fn(async (_since: string) => [] as InboxChange[]);
    const feed = new InboxChangeFeed({ pollMs: () => 5, fetchChanges });
    await tick(20);
    expect(fetchChanges).not.toHaveBeenCalled();
    const off = feed.subscribe(() => {});
    await tick(30);
    expect(fetchChanges.mock.calls.length).toBeGreaterThan(1);
    off();
    const after = fetchChanges.mock.calls.length;
    await tick(30);
    expect(fetchChanges.mock.calls.length).toBe(after);
  });

  it("re-reads the overlap window without re-emitting rows it already announced", async () => {
    const base = Date.parse("2026-09-18T12:00:00.000Z");
    let batch: InboxChange[] = [];
    const fetchChanges = vi.fn(async (_since: string) => batch);
    const feed = new InboxChangeFeed({ pollMs: () => 5, overlapMs: 3_000, now: () => base, fetchChanges });
    const heard: InboxChange[][] = [];
    const off = feed.subscribe(changes => heard.push(changes));

    batch = [row("c1", "2026-09-18T12:00:01.000Z")];
    await tick(30);
    expect(heard.flat().map(change => change.conversationId)).toEqual(["c1"]);
    // Same row, same stamp, still inside the overlap window: silent.
    await tick(30);
    expect(heard.flat()).toHaveLength(1);
    // A fresh bump of the same conversation is a new change.
    batch = [row("c1", "2026-09-18T12:00:02.000Z"), row("c2", "2026-09-18T12:00:02.500Z")];
    await tick(30);
    expect(heard.flat().map(change => change.conversationId)).toEqual(["c1", "c1", "c2"]);
    // The window trails the newest stamp by the overlap, never the wall clock.
    const since = fetchChanges.mock.calls.at(-1)?.[0] as string;
    expect(since).toBe(new Date(Date.parse("2026-09-18T12:00:02.500Z") - 3_000).toISOString());
    off();
  });

  it("starts from the moment of the first subscription, not from history", async () => {
    const base = Date.parse("2026-09-18T12:00:00.000Z");
    const fetchChanges = vi.fn(async (_since: string) => [] as InboxChange[]);
    const feed = new InboxChangeFeed({ pollMs: () => 5, overlapMs: 1_000, now: () => base, fetchChanges });
    const off = feed.subscribe(() => {});
    await tick(20);
    expect(fetchChanges.mock.calls[0]?.[0]).toBe(new Date(base - 1_000).toISOString());
    off();
  });

  it("later subscribers never push back the pending tick", async () => {
    const fetchChanges = vi.fn(async (_since: string) => [] as InboxChange[]);
    const feed = new InboxChangeFeed({ pollMs: () => 60, fetchChanges });
    const offA = feed.subscribe(() => {});
    // A steady stream of new tabs arriving before the first tick fires.
    const offs: Array<() => void> = [];
    for (let i = 0; i < 4; i += 1) {
      await tick(12);
      offs.push(feed.subscribe(() => {}));
    }
    // 48 ms in: the original 60 ms tick is still pending, nothing reset it.
    expect(fetchChanges).not.toHaveBeenCalled();
    await tick(30);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    for (const off of offs) off();
    offA();
  });

  it("poke runs a tick now and coalesces pokes made mid-tick", async () => {
    let release: () => void = () => {};
    const fetchChanges = vi.fn(() => new Promise<InboxChange[]>(resolve => { release = () => resolve([]); }));
    const feed = new InboxChangeFeed({ pollMs: () => 10_000, fetchChanges });
    feed.poke(); // nobody listening: no work
    expect(fetchChanges).not.toHaveBeenCalled();
    const off = feed.subscribe(() => {});
    feed.poke();
    await tick(5);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    feed.poke();
    feed.poke();
    release();
    await tick(10);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    release();
    await tick(10);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    off();
  });

  it("notify fans out immediately and a throwing listener never blocks the others", () => {
    const feed = new InboxChangeFeed({ pollMs: () => 10_000, fetchChanges: async () => [] });
    const heard: string[] = [];
    const offBad = feed.subscribe(() => { throw new Error("boom"); });
    const offGood = feed.subscribe(changes => heard.push(...changes.map(change => change.conversationId)));
    feed.notify(row("c9", "2026-09-18T12:00:09.000Z"));
    expect(heard).toEqual(["c9"]);
    offBad();
    offGood();
  });
});
