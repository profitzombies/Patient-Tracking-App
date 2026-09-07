/**
 * Offline write queue for the live patient rail — the pure part.
 *
 * Every real-account diary write (entries, water, targets, prefs, library,
 * check-ins, flags, photos) becomes a QueuedWrite: applied to local state at
 * once, persisted per account, and replayed in order once the server is
 * reachable. This module owns the parts with no React or native imports so
 * the Node suites can exercise them directly:
 *
 *   - the queued-write shapes and their local projection (`projectWrite`),
 *   - the retry policy (`classifyWriteFailure`, `backoffDelay`, attempt cap),
 *   - reconciliation against fresh server truth (`reconcileQueue`),
 *   - the pending-entity index the UI draws its markers from,
 *   - the serialized form (photo bytes are stored out of line).
 *
 * The provider (context/PatientContext.tsx) owns the drain loop, storage,
 * connectivity and foreground triggers, and the account-epoch boundaries.
 */

import type {
  CheckIn,
  DailyTargets,
  FoodItem,
  MealLogEntry,
  ProgressPhoto,
  SavedRecipe,
} from '@/data/patient-data';
import { PatientDataError } from '@/lib/patient-data-error';
import type { DoseLogWrite, LibraryWrite, PatientFlagsWrite } from '@/context/PatientAccountContext';
import type { DoseLogRecord, MedicationRecord } from '@/lib/medication-schedule';

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type QueuedWritePayload =
  | { kind: 'entries'; upsert?: MealLogEntry[]; deleteIds?: string[]; recents?: string[] }
  | { kind: 'water'; dateKey: string; oz: number }
  | { kind: 'targets'; partial: Partial<DailyTargets> }
  | { kind: 'prefs'; favorites?: string[]; recents?: string[] }
  | { kind: 'library'; input: LibraryWrite }
  | { kind: 'checkIn'; checkIn: CheckIn }
  /** Create-or-replace of one medication on the patient's list (keyed by id). */
  | { kind: 'medication'; medication: MedicationRecord }
  /** One dose decision per scheduled occurrence; `status: null` clears it. */
  | { kind: 'doseLog'; log: DoseLogWrite; loggedAt: string }
  | { kind: 'flags'; flags: Partial<PatientFlagsWrite> }
  /** Grid rows whose bytes are already on the media rail (objectPath set). */
  | { kind: 'photos'; photos: ProgressPhoto[] }
  | { kind: 'photoRemove'; photoId: string }
  /**
   * A photo captured offline: `photo.uri` holds the prepared data URI until
   * the upload lands; `uploadedPath` records a finished upload so a replay
   * after a lost grid-write response never uploads the bytes twice. The
   * upload itself is pinned by `uploadId` (defaults to the photo id): the
   * server mints the SAME object path for it every time, so a lost
   * finalize response re-uploads onto that object, never a second one.
   */
  | { kind: 'photoUpload'; photo: ProgressPhoto; uploadedPath?: string; uploadId?: string };

export type QueuedWriteKind = QueuedWritePayload['kind'];

export type QueuedWriteStatus = 'pending' | 'failed';

export interface QueuedWrite {
  /** Stable client id — doubles as the server idempotency key. */
  id: string;
  payload: QueuedWritePayload;
  /** Plain-words description for the sync detail sheet ("Logged Greek yogurt"). */
  summary: string;
  createdAt: number;
  attempts: number;
  /** Epoch ms before which the drain must not try this item again. */
  nextAttemptAt: number;
  status: QueuedWriteStatus;
  lastError: string | null;
  /**
   * Ids of rows this write EDITS (as opposed to creates). If server truth
   * later shows such a row gone — deleted from another device, or by staff —
   * the edit is dropped rather than resurrecting the row (see reconcileQueue).
   */
  editIds?: string[];
}

/** The slices of the provider's state a queued write can touch. */
export interface WriteProjectionState {
  addedEntries: MealLogEntry[];
  waterOverrides: Record<string, number>;
  addedCheckIns: CheckIn[];
  medications: MedicationRecord[];
  doseLogs: DoseLogRecord[];
  photos: ProgressPhoto[];
  favorites: string[];
  customFoods: FoodItem[];
  savedRecipes: SavedRecipe[];
  recents: string[];
  targetOverrides: Partial<DailyTargets>;
  nudgeOptOut: boolean;
  nudgeEngaged: boolean;
  nudgeLastSentKey: string | null;
  nudgeLastCrossingKey: string | null;
}

// ─── Retry policy ───────────────────────────────────────────────────────────

/**
 * Tunables, exported as one mutable object so scripted suites can shrink
 * the clock without reaching into the provider. Production never writes it.
 */
export const WRITE_QUEUE_TUNING = {
  /** First retry waits this long; each further attempt doubles it. */
  baseDelayMs: 2_000,
  /** Ceiling for the doubling. */
  maxDelayMs: 5 * 60_000,
  /** After this many failed attempts an item is parked as `failed`. */
  maxAttempts: 10,
};

/** Delay before attempt number `attempts + 1`, given `attempts` failures so far. */
export function backoffDelay(attempts: number): number {
  const { baseDelayMs, maxDelayMs } = WRITE_QUEUE_TUNING;
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

export type WriteFailureClass = 'retry' | 'permanent';

/**
 * Whether a failed attempt could ever succeed on replay. Anything without a
 * server answer (offline, timeout, signed out, misconfigured build) and any
 * server-side trouble (5xx) is worth retrying. A 4xx means the request
 * itself is unacceptable, so re-sending it is pointless — except the
 * transient ones: 401 (a token refresh fixes it), 408/425/429 (try later).
 */
export function classifyWriteFailure(error: unknown): WriteFailureClass {
  if (!(error instanceof PatientDataError)) return 'retry';
  if (error.kind !== 'http' || error.status === null) return 'retry';
  const status = error.status;
  if (status >= 500) return 'retry';
  if (status === 401 || status === 408 || status === 425 || status === 429) return 'retry';
  if (status >= 400) return 'permanent';
  return 'retry';
}

export function failureMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'That didn’t save. Check your connection and try again.';
}

/** Records one failed attempt and decides whether the item keeps waiting or parks. */
export function markAttemptFailed(item: QueuedWrite, error: unknown, now: number): QueuedWrite {
  const attempts = item.attempts + 1;
  const permanent =
    classifyWriteFailure(error) === 'permanent' || attempts >= WRITE_QUEUE_TUNING.maxAttempts;
  return {
    ...item,
    attempts,
    lastError: failureMessage(error),
    status: permanent ? 'failed' : 'pending',
    nextAttemptAt: permanent ? now : now + backoffDelay(attempts),
  };
}

/** Manual retry from the detail sheet: back to the front of the pending line. */
export function markRetryRequested(item: QueuedWrite, now: number): QueuedWrite {
  return { ...item, status: 'pending', attempts: 0, nextAttemptAt: now, lastError: null };
}

// ─── Projection ─────────────────────────────────────────────────────────────

function upsertById<T extends { id: string }>(rows: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return rows;
  const byId = new Map(incoming.map(row => [row.id, row]));
  const seen = new Set<string>();
  const next = rows.map(row => {
    const replacement = byId.get(row.id);
    if (!replacement) return row;
    seen.add(row.id);
    return replacement;
  });
  for (const row of incoming) if (!seen.has(row.id)) next.push(row);
  return next;
}

function withoutIds<T extends { id: string }>(rows: T[], ids: string[] | undefined): T[] {
  if (!ids || ids.length === 0) return rows;
  const gone = new Set(ids);
  return rows.filter(row => !gone.has(row.id));
}

/**
 * Applies one queued write to a state snapshot. Mirrors what the server will
 * do with the same payload, so `project(serverTruth, queue)` is exactly what
 * the account will read back once every item has landed.
 */
export function projectWrite<S extends WriteProjectionState>(base: S, item: QueuedWrite): S {
  const write = item.payload;
  switch (write.kind) {
    case 'entries': {
      let addedEntries = upsertById(base.addedEntries, write.upsert ?? []);
      addedEntries = withoutIds(addedEntries, write.deleteIds);
      return {
        ...base,
        addedEntries,
        ...(write.recents ? { recents: write.recents } : {}),
      };
    }
    case 'water':
      return { ...base, waterOverrides: { ...base.waterOverrides, [write.dateKey]: write.oz } };
    case 'targets':
      return { ...base, targetOverrides: { ...base.targetOverrides, ...write.partial } };
    case 'prefs':
      return {
        ...base,
        ...(write.favorites ? { favorites: write.favorites } : {}),
        ...(write.recents ? { recents: write.recents } : {}),
      };
    case 'library': {
      const input = write.input;
      return {
        ...base,
        customFoods: withoutIds(
          upsertById(base.customFoods, input.foodUpsert ?? []),
          input.foodDeleteIds,
        ),
        savedRecipes: withoutIds(
          upsertById(base.savedRecipes, input.recipeUpsert ?? []),
          input.recipeDeleteIds,
        ),
        ...(input.favorites ? { favorites: input.favorites } : {}),
        ...(input.recents ? { recents: input.recents } : {}),
      };
    }
    case 'checkIn':
      return {
        ...base,
        addedCheckIns: [
          ...base.addedCheckIns.filter(row => row.dateKey !== write.checkIn.dateKey),
          write.checkIn,
        ],
      };
    case 'medication':
      return { ...base, medications: upsertById(base.medications, [write.medication]) };
    case 'doseLog': {
      const { log } = write;
      const rest = base.doseLogs.filter(
        row => !(row.medicationId === log.medicationId && row.dueDate === log.dueDate && row.dueTime === log.dueTime),
      );
      if (log.status === null) return { ...base, doseLogs: rest };
      return {
        ...base,
        doseLogs: [
          ...rest,
          {
            id: log.id,
            medicationId: log.medicationId,
            dueDate: log.dueDate,
            dueTime: log.dueTime,
            status: log.status,
            source: log.source,
            loggedAt: write.loggedAt,
          },
        ],
      };
    }
    case 'flags': {
      const flags = write.flags;
      return {
        ...base,
        ...(flags.nudgeOptOut !== undefined ? { nudgeOptOut: flags.nudgeOptOut } : {}),
        ...(flags.nudgeEngaged !== undefined ? { nudgeEngaged: flags.nudgeEngaged } : {}),
        ...(flags.nudgeLastSentKey !== undefined ? { nudgeLastSentKey: flags.nudgeLastSentKey } : {}),
        ...(flags.nudgeLastCrossingKey !== undefined
          ? { nudgeLastCrossingKey: flags.nudgeLastCrossingKey }
          : {}),
      };
    }
    case 'photos':
      return { ...base, photos: upsertById(base.photos, write.photos) };
    case 'photoRemove':
      return { ...base, photos: withoutIds(base.photos, [write.photoId]) };
    case 'photoUpload': {
      let photo = write.photo;
      if (write.uploadedPath) {
        // Uploaded: the stored object is the source of truth and the local
        // bytes drop out of the projection.
        const { uri: _uri, ...rest } = write.photo;
        photo = { ...rest, objectPath: write.uploadedPath };
      }
      return { ...base, photos: upsertById(base.photos, [photo]) };
    }
  }
}

export function projectQueue<S extends WriteProjectionState>(base: S, queue: readonly QueuedWrite[]): S {
  return queue.reduce((state, item) => projectWrite(state, item), base);
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Trims a queue against freshly hydrated server truth. Server-confirmed data
 * wins: an EDIT of a row the server no longer has (someone deleted it since
 * the edit queued) is dropped instead of being replayed as a resurrection.
 * Creates, deletes, and whole-value writes (water, targets, prefs, flags,
 * check-ins) are the patient's intent and always replay.
 */
export function reconcileQueue(
  queue: readonly QueuedWrite[],
  truth: Pick<WriteProjectionState, 'addedEntries' | 'customFoods' | 'savedRecipes' | 'photos'>,
): QueuedWrite[] {
  const present = new Set<string>([
    ...truth.addedEntries.map(row => row.id),
    ...truth.customFoods.map(row => row.id),
    ...truth.savedRecipes.map(row => row.id),
    ...truth.photos.map(row => row.id),
  ]);
  const out: QueuedWrite[] = [];
  for (const item of queue) {
    if (!item.editIds || item.editIds.length === 0) {
      out.push(item);
      continue;
    }
    const missing = new Set(item.editIds.filter(id => !present.has(id)));
    if (missing.size === 0) {
      out.push(item);
      continue;
    }
    const pruned = pruneMissingEdits(item, missing);
    if (pruned) out.push(pruned);
  }
  return out;
}

function pruneMissingEdits(item: QueuedWrite, missing: Set<string>): QueuedWrite | null {
  const editIds = item.editIds!.filter(id => !missing.has(id));
  const write = item.payload;
  switch (write.kind) {
    case 'entries': {
      const upsert = (write.upsert ?? []).filter(row => !missing.has(row.id));
      const stillWrites =
        upsert.length > 0 || (write.deleteIds?.length ?? 0) > 0 || write.recents !== undefined;
      if (!stillWrites) return null;
      return { ...item, editIds, payload: { ...write, upsert } };
    }
    case 'library': {
      const input = write.input;
      const foodUpsert = (input.foodUpsert ?? []).filter(row => !missing.has(row.id));
      const recipeUpsert = (input.recipeUpsert ?? []).filter(row => !missing.has(row.id));
      const stillWrites =
        foodUpsert.length > 0 ||
        recipeUpsert.length > 0 ||
        (input.foodDeleteIds?.length ?? 0) > 0 ||
        (input.recipeDeleteIds?.length ?? 0) > 0 ||
        input.favorites !== undefined ||
        input.recents !== undefined;
      if (!stillWrites) return null;
      return { ...item, editIds, payload: { kind: 'library', input: { ...input, foodUpsert, recipeUpsert } } };
    }
    default:
      // Only entry and library edits carry editIds today; anything else
      // whose edited row vanished is dropped whole.
      return null;
  }
}

// ─── Pending-entity index ───────────────────────────────────────────────────

/**
 * Keys the UI asks about: `entry:<id>`, `water:<dateKey>`, `checkIn:<dateKey>`,
 * `photo:<id>`, `food:<id>`, `recipe:<id>`, `medication:<id>`,
 * `dose:<medicationId>:<dueDate>:<dueTime>`, plus the singletons `targets`,
 * `prefs`, `flags`.
 */
export function pendingEntityKeys(queue: readonly QueuedWrite[]): Set<string> {
  const keys = new Set<string>();
  for (const item of queue) {
    const write = item.payload;
    switch (write.kind) {
      case 'entries':
        for (const row of write.upsert ?? []) keys.add(`entry:${row.id}`);
        if (write.recents) keys.add('prefs');
        break;
      case 'water':
        keys.add(`water:${write.dateKey}`);
        break;
      case 'targets':
        keys.add('targets');
        break;
      case 'prefs':
        keys.add('prefs');
        break;
      case 'library':
        for (const row of write.input.foodUpsert ?? []) keys.add(`food:${row.id}`);
        for (const row of write.input.recipeUpsert ?? []) keys.add(`recipe:${row.id}`);
        if (write.input.favorites || write.input.recents) keys.add('prefs');
        break;
      case 'checkIn':
        keys.add(`checkIn:${write.checkIn.dateKey}`);
        break;
      case 'medication':
        keys.add(`medication:${write.medication.id}`);
        break;
      case 'doseLog':
        keys.add(`dose:${write.log.medicationId}:${write.log.dueDate}:${write.log.dueTime}`);
        break;
      case 'flags':
        keys.add('flags');
        break;
      case 'photos':
        for (const row of write.photos) keys.add(`photo:${row.id}`);
        break;
      case 'photoRemove':
        break;
      case 'photoUpload':
        keys.add(`photo:${write.photo.id}`);
        break;
    }
  }
  return keys;
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Photo bytes never ride the queue file: a data URI can be megabytes and the
 * queue is rewritten on every ack. The provider stores each pending upload's
 * data URI under its own key and stitches it back on load.
 */
export function stripPhotoBytes(item: QueuedWrite): QueuedWrite {
  if (item.payload.kind !== 'photoUpload') return item;
  const { uri: _uri, ...photo } = item.payload.photo;
  return { ...item, payload: { ...item.payload, photo } };
}

export function serializeQueue(queue: readonly QueuedWrite[]): string {
  return JSON.stringify(queue.map(stripPhotoBytes));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parses a stored queue, dropping anything that isn't a well-formed item. */
export function parseQueue(raw: string | null): QueuedWrite[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: QueuedWrite[] = [];
  for (const candidate of parsed) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.id !== 'string' || !isRecord(candidate.payload)) continue;
    if (typeof candidate.payload.kind !== 'string') continue;
    out.push({
      id: candidate.id,
      payload: candidate.payload as unknown as QueuedWritePayload,
      summary: typeof candidate.summary === 'string' ? candidate.summary : 'Saved change',
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
      attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
      nextAttemptAt: typeof candidate.nextAttemptAt === 'number' ? candidate.nextAttemptAt : 0,
      status: candidate.status === 'failed' ? 'failed' : 'pending',
      lastError: typeof candidate.lastError === 'string' ? candidate.lastError : null,
      ...(Array.isArray(candidate.editIds)
        ? { editIds: candidate.editIds.filter((id): id is string => typeof id === 'string') }
        : {}),
    });
  }
  return out;
}

/** Sync status the patient tab shell shows. */
export type SyncStatus = 'offline' | 'syncing' | 'attention' | 'idle';

export function deriveSyncStatus(
  queue: readonly QueuedWrite[],
  online: boolean,
): SyncStatus {
  if (!online) return 'offline';
  if (queue.some(item => item.status === 'failed')) return 'attention';
  if (queue.length > 0) return 'syncing';
  return 'idle';
}
