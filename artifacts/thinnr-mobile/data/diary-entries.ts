/**
 * Helpers for working with already-logged diary entries: rescaling an entry
 * to a new quantity, and ranking library items by how often they were logged.
 * Rescaling always works from the entry's own stored snapshot (logged totals
 * ÷ logged quantity), never from the current library food or recipe — those
 * may have been edited or deleted since the entry was logged.
 */
import type { MealLogEntry, MealSlot } from '@/data/patient-data';

/** How often a library item was logged, for "most logged" ranking. */
export interface LoggedFrequency {
  refId: string;
  count: number;
}

/**
 * Rank library items (foods/recipes) by how often they appear in the diary on
 * or after `sinceKey` (a YYYY-MM-DD date key, inclusive). Ties fall back to
 * the most recent logged date, then to log order, so the result is fully
 * deterministic — the seeded demo history always produces the same list.
 * Entries without a refId are skipped; callers apply their own minimum-count
 * or length caps.
 */
export function rankMostLogged(entries: MealLogEntry[], sinceKey: string): LoggedFrequency[] {
  const stats = new Map<string, { count: number; lastDateKey: string; lastIndex: number }>();
  entries.forEach((entry, index) => {
    if (!entry.refId || entry.dateKey < sinceKey) return;
    const prev = stats.get(entry.refId);
    if (!prev) {
      stats.set(entry.refId, { count: 1, lastDateKey: entry.dateKey, lastIndex: index });
      return;
    }
    prev.count += 1;
    if (entry.dateKey >= prev.lastDateKey) {
      prev.lastDateKey = entry.dateKey;
      prev.lastIndex = index;
    }
  });
  return [...stats.entries()]
    .sort(([, a], [, b]) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.lastDateKey !== b.lastDateKey) return a.lastDateKey < b.lastDateKey ? 1 : -1;
      return b.lastIndex - a.lastIndex;
    })
    .map(([refId, { count }]) => ({ refId, count }));
}

export function formatQty(qty: number): string {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
}

/**
 * Detail-line marker for entries whose totals include ingredient-level
 * adjustments ("1 serving · recipe · adjusted"). Kept as a strict suffix so
 * it is reversible and survives rebuildDetail: both detail formats keep
 * everything after the quantity, the suffix included.
 */
export const ADJUSTED_TAG_SUFFIX = ' · adjusted';

export function withAdjustedTag(detail: string): string {
  return detail.endsWith(ADJUSTED_TAG_SUFFIX) ? detail : `${detail}${ADJUSTED_TAG_SUFFIX}`;
}

export function stripAdjustedTag(detail: string): string {
  return detail.endsWith(ADJUSTED_TAG_SUFFIX)
    ? detail.slice(0, -ADJUSTED_TAG_SUFFIX.length)
    : detail;
}

/**
 * Clone already-logged entries onto another day — "copy yesterday's breakfast
 * onto today" — optionally forcing every clone into one meal slot. Clones are
 * plain user-added entries with fresh ids from `makeId`, and they carry the
 * source entry's logged snapshot (name/detail/quantity/calories/macros)
 * untouched: values are never re-derived from the current library food or
 * recipe, which may have been edited or deleted since the source was logged.
 * Sources may be seeded or user-added; neither the array nor its entries are
 * mutated. Clone order preserves source order.
 */
export function cloneEntriesForCopy(
  sources: MealLogEntry[],
  target: { dateKey: string; meal?: MealSlot },
  makeId: () => string,
): MealLogEntry[] {
  return sources.map(source => ({
    ...source,
    id: makeId(),
    dateKey: target.dateKey,
    meal: target.meal ?? source.meal,
  }));
}

type EntrySnapshot = Pick<
  MealLogEntry,
  'kind' | 'detail' | 'quantity' | 'calories' | 'protein' | 'carbs' | 'fat'
>;

/**
 * Rebuild the human-readable detail line for a new quantity, preserving the
 * serving descriptor from the existing detail. Handles every format we log:
 * "2 × 4 oz", "4 oz" (seeded qty 1), "1 serving", "2 servings · recipe".
 */
function rebuildDetail(entry: EntrySnapshot, quantity: number): string {
  const qty = formatQty(quantity);
  if (entry.kind === 'recipe') {
    const match = entry.detail.match(/^\d+(?:\.\d+)?\s+servings?(.*)$/);
    const suffix = match ? match[1] : '';
    return `${qty} serving${quantity === 1 ? '' : 's'}${suffix}`;
  }
  const match = entry.detail.match(/^\d+(?:\.\d+)?\s*×\s*(.*)$/);
  const serving = match ? match[1] : entry.detail;
  return `${qty} × ${serving}`;
}

/** New detail + macro totals for an entry rescaled to a new quantity. */
export function rescaleEntrySnapshot(
  entry: EntrySnapshot,
  quantity: number,
): Pick<MealLogEntry, 'detail' | 'quantity' | 'calories' | 'protein' | 'carbs' | 'fat'> {
  const baseQty = entry.quantity > 0 ? entry.quantity : 1;
  const scale = (total: number) => Math.round((total / baseQty) * quantity);
  return {
    detail: quantity === entry.quantity ? entry.detail : rebuildDetail(entry, quantity),
    quantity,
    calories: scale(entry.calories),
    protein: scale(entry.protein),
    carbs: scale(entry.carbs),
    fat: scale(entry.fat),
  };
}
