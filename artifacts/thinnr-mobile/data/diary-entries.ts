/**
 * Helpers for editing already-logged diary entries. Rescaling always works
 * from the entry's own stored snapshot (logged totals ÷ logged quantity),
 * never from the current library food or recipe — those may have been edited
 * or deleted since the entry was logged.
 */
import type { MealLogEntry } from '@/data/patient-data';

export function formatQty(qty: number): string {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
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
