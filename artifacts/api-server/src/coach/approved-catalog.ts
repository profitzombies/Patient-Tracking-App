/**
 * Server-side view of the THINNR Approved Foods list.
 *
 * Imports the mobile app's dependency-free verbatim data module directly
 * (single source of truth — no copied strings, so the mobile verbatim test
 * keeps guarding the wording). esbuild bundles the file into the server
 * build; it has no Expo/React imports.
 */
import {
  APPROVED_FOOD_CATEGORIES,
  type ApprovedFoodItem,
} from "../../../thinnr-mobile/data/approved-foods";

export interface CatalogEntry {
  id: string;
  name: string;
  categoryTitle: string;
}

const entries: CatalogEntry[] = [];
const byId = new Map<string, CatalogEntry>();

for (const category of APPROVED_FOOD_CATEGORIES) {
  for (const item of category.items as ApprovedFoodItem[]) {
    const entry: CatalogEntry = {
      id: item.id,
      name: item.name,
      categoryTitle: category.title,
    };
    entries.push(entry);
    byId.set(item.id, entry);
  }
}

if (entries.length < 40) {
  // The list is a fixed program document; a tiny count means the import broke.
  throw new Error(`Approved-foods catalog looks wrong: only ${entries.length} items`);
}

export const APPROVED_CATALOG: readonly CatalogEntry[] = entries;

export function isApprovedItemId(id: string): boolean {
  return byId.has(id);
}

export function approvedItemName(id: string): string | undefined {
  return byId.get(id)?.name;
}

/**
 * Preparation/connective vocabulary allowed in ingredient names beyond the
 * cited catalog item's own words. Strictly non-food: a food word missing from
 * the catalog entry must fail the match, so nothing edible can sneak in here.
 */
const PREP_WORDS = new Set([
  "a", "an", "the", "of", "or", "and", "with", "in", "on", "for", "to", "per",
  "grilled", "baked", "roasted", "broiled", "steamed", "boiled", "poached",
  "seared", "cooked", "raw", "fresh", "frozen", "thawed", "warm", "cold",
  "chilled", "toasted", "crispy", "crisped", "crumbled", "chopped", "diced",
  "minced", "sliced", "shredded", "grated", "zested", "juiced", "halved",
  "quartered", "cubed", "cut", "torn", "trimmed", "peeled", "seeded", "cored",
  "mashed", "whipped", "beaten", "mixed", "rinsed", "drained", "packed",
  "ground", "lean", "skinless", "boneless", "thin", "thinly", "thick",
  "thickly", "finely", "coarsely", "lightly", "large", "small", "medium",
  "extra", "optional", "plain", "whole", "half", "wedges", "spears",
  "florets", "leaves", "strips", "cubes", "pieces", "slices", "taste",
]);

/** Shared light stemmer so plural/singular differences never break a match. */
function stemToken(token: string): string {
  if (token.length > 3 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 2 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(stemToken);
}

/**
 * True when an ingredient name provably reads as the catalog item it cites:
 * every token is either a word of that catalog entry or a non-food
 * preparation word, and at least one catalog word anchors the identity. This
 * is what stops "chocolate cake" from riding in on a valid approved id.
 */
export function ingredientNameMatchesItem(name: string, id: string): boolean {
  const entry = byId.get(id);
  if (!entry) return false;
  const catalogTokens = new Set(nameTokens(entry.name));
  let anchored = false;
  for (const token of nameTokens(name)) {
    if (catalogTokens.has(token)) {
      if (!PREP_WORDS.has(token)) anchored = true;
      continue;
    }
    if (!PREP_WORDS.has(token)) return false;
  }
  return anchored;
}

/** Compact catalog listing for the model prompt: `id — name` grouped by section. */
export function catalogPromptLines(): string {
  const byCategory = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.categoryTitle) ?? [];
    list.push(entry);
    byCategory.set(entry.categoryTitle, list);
  }
  const lines: string[] = [];
  for (const [title, items] of byCategory) {
    lines.push(`# ${title}`);
    for (const item of items) lines.push(`${item.id} — ${item.name}`);
  }
  return lines.join("\n");
}
