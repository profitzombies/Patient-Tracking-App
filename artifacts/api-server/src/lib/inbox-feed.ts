/**
 * Inbox change feed: ONE shared watcher over patient chat conversations that
 * fans changes out to every open staff inbox stream.
 *
 * Why: every open inbox tab used to ask the server for the thread list and
 * the open thread's events every five seconds, whether or not anything had
 * changed. That load scaled with staff headcount and hit the same server and
 * database that serve patients. Message rows are written by several paths
 * (patient app persistence, care-team sends, staff replies) and workflow
 * state is derived by a database trigger, so the one thing every change has
 * in common is the conversation row's `updated_at` bump. This feed watches
 * that column with a single lightweight query per tick while at least one
 * stream is subscribed (and nothing at all when none is), dedupes rows across
 * an overlap window so a late-committing transaction is never missed, and
 * lets in-process writers push a change immediately without waiting for the
 * next tick.
 *
 * Access rules stay in the routes: the feed knows only which conversation
 * changed and who owns it; each subscriber filters by its own scope.
 */
import { logger } from "./logger";
import { supabaseAdmin } from "./supabase-admin";

export interface InboxChange {
  conversationId: string;
  patientId: string | null;
  /** The office that would see this thread in its inbox (care-team threads
   * are bound to their office; AI threads follow the patient's provider). */
  providerId: string | null;
  thread: string;
  updatedAt: string;
}

export type InboxListener = (changes: InboxChange[]) => void;

export interface InboxFeedOptions {
  /** Poll cadence while subscribed; read per tick so tests can shrink it. */
  pollMs?: () => number;
  /** How far behind the newest seen timestamp each poll re-reads. */
  overlapMs?: number;
  now?: () => number;
  fetchChanges?: (sinceIso: string) => Promise<InboxChange[]>;
}

const DEFAULT_POLL_MS = 1_500;
const DEFAULT_OVERLAP_MS = 3_000;
const PAGE = 500;
const enc = encodeURIComponent;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Poll cadence of the shared watcher (INBOX_FEED_POLL_MS, default 1.5 s). */
export function inboxFeedPollMs(): number {
  return envPositiveInt("INBOX_FEED_POLL_MS", DEFAULT_POLL_MS);
}

/** Longest a single inbox stream stays open before the explicit end signal
 * (INBOX_STREAM_MAX_MS, default 10 min) so credentials are re-verified on
 * reconnect instead of trusted forever. */
export function inboxStreamMaxMs(): number {
  return envPositiveInt("INBOX_STREAM_MAX_MS", 10 * 60_000);
}

function changeFromRow(row: Record<string, unknown>): InboxChange {
  const patient = (row.patients ?? null) as Record<string, unknown> | null;
  const thread = String(row.thread ?? "");
  const boundProvider = typeof row.provider_id === "string" ? row.provider_id : null;
  const patientProvider = patient && typeof patient.provider_id === "string" ? patient.provider_id : null;
  return {
    conversationId: String(row.id),
    patientId: typeof row.patient_id === "string" ? row.patient_id : null,
    providerId: thread === "care_team" ? boundProvider : (patientProvider ?? boundProvider),
    thread,
    updatedAt: String(row.updated_at),
  };
}

async function fetchChangedConversations(sinceIso: string): Promise<InboxChange[]> {
  const result = await supabaseAdmin("GET",
    `/rest/v1/patient_chat_conversations?select=id,patient_id,provider_id,thread,updated_at,patients(provider_id)` +
    `&updated_at=gt.${enc(sinceIso)}&order=updated_at.asc&limit=${PAGE}`);
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`inbox feed poll failed (${result.status})`);
  return (result.json as Record<string, unknown>[]).map(changeFromRow);
}

export class InboxChangeFeed {
  private readonly listeners = new Set<InboxListener>();
  private readonly pollMs: () => number;
  private readonly overlapMs: number;
  private readonly now: () => number;
  private readonly fetchChanges: (sinceIso: string) => Promise<InboxChange[]>;
  private timer: NodeJS.Timeout | null = null;
  private watermarkMs = 0;
  private ticking = false;
  private pokeRequested = false;
  /** Newest announced stamp (ms) per conversation inside the overlap window. */
  private readonly seen = new Map<string, number>();

  constructor(options: InboxFeedOptions = {}) {
    this.pollMs = options.pollMs ?? inboxFeedPollMs;
    this.overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
    this.now = options.now ?? Date.now;
    this.fetchChanges = options.fetchChanges ?? fetchChangedConversations;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Registers a listener; the watcher starts with the first subscriber and
   * stops with the last. History before the first subscription is never
   * replayed — subscribers catch up through their own fetch. */
  subscribe(listener: InboxListener): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first) {
      this.watermarkMs = this.now();
      this.seen.clear();
      // Only the first subscriber arms the watcher: later subscribers must not
      // push back a pending tick, or a steady flow of new tabs would starve
      // every open stream of database changes.
      this.schedule(this.pollMs());
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  /** Asks for a tick as soon as possible (coalesced with any tick in flight).
   * Writers call this right after a database write so same-process
   * subscribers hear about it without waiting for the cadence. */
  poke(): void {
    if (this.listeners.size === 0) return;
    if (this.ticking) { this.pokeRequested = true; return; }
    this.schedule(0);
  }

  /** Fans a change out immediately, bypassing the database read. For
   * changes the watcher cannot see (notes, escalations) and for instant
   * delivery of writes this process just made. */
  notify(change: InboxChange): void {
    if (this.listeners.size === 0) return;
    this.emit([change]);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
    this.timer.unref?.();
  }

  private emit(changes: InboxChange[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(changes);
      } catch (error) {
        logger.warn({ err: error }, "inbox feed listener failed");
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.listeners.size === 0) return;
    if (this.ticking) { this.pokeRequested = true; return; }
    this.ticking = true;
    try {
      const sinceMs = this.watermarkMs - this.overlapMs;
      const rows = await this.fetchChanges(new Date(sinceMs).toISOString());
      const fresh: InboxChange[] = [];
      for (const row of rows) {
        const stamp = Date.parse(row.updatedAt);
        if (!Number.isFinite(stamp)) continue;
        if (stamp > this.watermarkMs) this.watermarkMs = stamp;
        if ((this.seen.get(row.conversationId) ?? -Infinity) >= stamp) continue;
        this.seen.set(row.conversationId, stamp);
        fresh.push(row);
      }
      // Rows older than the overlap window can never be re-read, so their
      // dedupe entries are dead weight.
      const floor = this.watermarkMs - this.overlapMs;
      for (const [id, stamp] of this.seen) {
        if (stamp < floor) this.seen.delete(id);
      }
      if (fresh.length > 0) this.emit(fresh);
    } catch (error) {
      logger.warn({ err: error }, "inbox feed poll failed");
    } finally {
      this.ticking = false;
      if (this.listeners.size > 0) {
        const immediate = this.pokeRequested;
        this.pokeRequested = false;
        this.schedule(immediate ? 0 : this.pollMs());
      }
    }
  }
}

/** The process-wide feed every inbox stream shares. */
export const inboxFeed = new InboxChangeFeed();
