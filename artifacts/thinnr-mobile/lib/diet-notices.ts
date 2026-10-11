/**
 * In-app diet notices derived from the diet slice itself — there is no
 * separate feed endpoint for them:
 *
 *  - "your provider changed your diet": the current selection was not made
 *    by the patient and this device has not acknowledged it yet;
 *  - "pregnancy conflict": the screening answers conflict with the diet in
 *    force and the care team has been asked to review.
 *
 * Acknowledgements are device-local (per account) so a dismissed notice does
 * not come back on the next refresh, and a provider's NEXT change shows again
 * because it carries a new selection id.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { DIET_BY_SLUG } from '@/lib/diet-fit';
import { providerChangedDiet, type DietState } from '@/lib/diet-state';

const STORAGE_KEY = 'thinnr_diet_notices_v1';

interface Dismissals {
  /** accountKey → last acknowledged provider-set selection id. */
  providerChange: Record<string, string>;
  /** accountKey → `${selectionId}` whose pregnancy-conflict notice was dismissed. */
  pregnancyConflict: Record<string, string>;
}

const EMPTY: Dismissals = { providerChange: {}, pregnancyConflict: {} };
let memory: Dismissals | null = null;

async function readRaw(): Promise<string | null> {
  try {
    return Platform.OS === 'web'
      ? globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
      : await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

async function writeRaw(serialized: string): Promise<void> {
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(STORAGE_KEY, serialized);
    else await AsyncStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Device-local convenience only: a failed write just re-shows the notice.
  }
}

export async function loadDietDismissals(): Promise<Dismissals> {
  if (memory) return memory;
  const raw = await readRaw();
  let parsed: Dismissals = EMPTY;
  if (raw) {
    try {
      const value = JSON.parse(raw) as Partial<Dismissals>;
      parsed = {
        providerChange: typeof value.providerChange === 'object' && value.providerChange ? value.providerChange : {},
        pregnancyConflict: typeof value.pregnancyConflict === 'object' && value.pregnancyConflict ? value.pregnancyConflict : {},
      };
    } catch {
      parsed = EMPTY;
    }
  }
  memory = parsed;
  return parsed;
}

export async function dismissDietNotice(
  kind: keyof Dismissals,
  accountKey: string,
  id: string,
): Promise<Dismissals> {
  const current = await loadDietDismissals();
  const next: Dismissals = { ...current, [kind]: { ...current[kind], [accountKey]: id } };
  memory = next;
  await writeRaw(JSON.stringify(next));
  return next;
}

/** Test seam: forgets the in-memory copy so the next load re-reads storage. */
export function resetDietNoticeMemory(): void {
  memory = null;
}

export interface DietNotice {
  kind: 'provider_change' | 'pregnancy_conflict';
  /** Stable id the dismissal is keyed by. */
  id: string;
  title: string;
  body: string;
}

/** Pure: the notices to show for a diet slice given this device's dismissals. */
export function dietNoticesFor(diet: DietState | null, accountKey: string, dismissals: Dismissals | null): DietNotice[] {
  if (!diet) return [];
  const notices: DietNotice[] = [];
  const changed = providerChangedDiet(diet, dismissals?.providerChange[accountKey] ?? null);
  if (changed) {
    const name = DIET_BY_SLUG.get(changed.dietSlug)?.name ?? 'a new plan';
    notices.push({
      kind: 'provider_change',
      id: changed.id,
      title: 'Your care team updated your diet',
      body: `Your plan is now ${name}. Open Food preferences to see the rule sheet and settings.`,
    });
  }
  if (diet.screening.pregnancyConflict && diet.currentDiet) {
    const id = diet.currentDiet.id;
    if (dismissals?.pregnancyConflict[accountKey] !== id) {
      const name = DIET_BY_SLUG.get(diet.currentDiet.dietSlug)?.name ?? 'your current diet';
      notices.push({
        kind: 'pregnancy_conflict',
        id,
        title: 'Your care team has been asked to review',
        body: `${name} isn't recommended during pregnancy or breastfeeding. You can pick something else in Food preferences while they look.`,
      });
    }
  }
  return notices;
}
