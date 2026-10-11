/**
 * Resolves the way a patient *says* an allergy or sensitivity ("tree nuts",
 * "peanuts", "shrimp", "dairy", "I'm lactose intolerant") to the catalog key
 * the classifier reasons about. Catalog keys carry tag rules and ingredient
 * term lists; a custom item only ever matches its literal label, so a spoken
 * "tree nuts" saved as `custom:tree_nuts` would never block an almond dish.
 *
 * Only allergies and sensitivities resolve. Restrictions are always picked
 * from the catalog in the app, and dislikes have no catalog by design.
 *
 * The map is deliberately conservative: it names the allergen itself, its
 * plural and spelling variants, and the specific foods a patient commonly
 * names in place of the group (almonds -> tree nuts, shrimp -> shellfish).
 * Resolving a specific food to its group widens what the coach keeps away,
 * which is the safe direction for an allergy.
 */
import { ALLERGEN_KEYS, SENSITIVITY_BY_KEY, type AllergenKey, type PreferenceList } from "./vocabulary";

const ALLERGY_SYNONYMS: Record<AllergenKey, readonly string[]> = {
  milk: ["milk", "dairy", "dairy products", "cows milk", "cow milk", "milk products", "casein", "whey"],
  egg: ["egg", "eggs", "egg whites", "egg white", "egg yolk", "egg yolks"],
  peanut: ["peanut", "peanuts", "peanut butter", "groundnut", "groundnuts"],
  tree_nut: [
    "tree nut", "tree nuts", "treenuts", "nuts", "nut",
    "almond", "almonds", "walnut", "walnuts", "cashew", "cashews", "pecan", "pecans", "pistachio", "pistachios",
    "hazelnut", "hazelnuts", "macadamia", "macadamias", "macadamia nuts", "brazil nut", "brazil nuts", "pine nut", "pine nuts",
  ],
  soy: ["soy", "soya", "soybean", "soybeans", "soy beans", "soy products", "soy protein"],
  wheat: ["wheat"],
  fish: ["fish", "finned fish", "fin fish", "finfish", "seafood"],
  shellfish: [
    "shellfish", "shell fish", "crustaceans", "crustacean", "mollusks", "molluscs",
    "shrimp", "shrimps", "prawn", "prawns", "crab", "crabs", "lobster", "lobsters", "clam", "clams", "mussel", "mussels",
    "oyster", "oysters", "scallop", "scallops", "crawfish", "crayfish",
  ],
  sesame: ["sesame", "sesame seeds", "sesame seed", "tahini"],
  gluten: ["gluten"],
  mustard: ["mustard", "mustard seed", "mustard seeds"],
  celery: ["celery", "celeriac"],
  lupin: ["lupin", "lupine", "lupins"],
  sulfites: ["sulfites", "sulfite", "sulphites", "sulphite"],
  corn: ["corn", "maize"],
};

const SENSITIVITY_SYNONYMS: Record<string, readonly string[]> = {
  lactose: ["lactose", "dairy", "milk", "dairy products", "milk products", "cows milk", "cow milk"],
  gluten: ["gluten", "wheat", "bread", "wheat products"],
  fodmap: ["fodmap", "fodmaps", "high fodmap foods", "high fodmap"],
  histamine: ["histamine", "histamines", "high histamine foods"],
  caffeine: ["caffeine", "coffee"],
  nightshades: ["nightshade", "nightshades"],
  sulfites: ["sulfites", "sulfite", "sulphites", "sulphite"],
  artificial_sweeteners: ["artificial sweeteners", "artificial sweetener", "sweeteners", "sweetener", "aspartame", "sucralose", "diet soda", "diet sodas"],
  spicy: ["spicy food", "spicy foods", "spicy", "spice", "spices", "hot food", "hot sauce", "chili", "chilli", "chilies", "chillies"],
  fructose: ["fructose", "high fructose corn syrup"],
};

function normalizeSpoken(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildIndex(source: Record<string, readonly string[]>): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [key, phrases] of Object.entries(source)) {
    for (const phrase of phrases) {
      const normalized = normalizeSpoken(phrase);
      if (!index.has(normalized)) index.set(normalized, key);
    }
  }
  return index;
}

const ALLERGY_INDEX = buildIndex(ALLERGY_SYNONYMS);
const SENSITIVITY_INDEX = buildIndex(SENSITIVITY_SYNONYMS);

/** Leading filler the detector or a patient may leave on the phrase. */
const STRIP_LEADING = ["raw", "cooked", "all", "any", "most", "fresh"];

/**
 * The catalog key a spoken allergy or sensitivity label stands for, or null
 * when it should stay a custom item. The catalog key itself (e.g. "tree_nut")
 * also resolves, so callers can pass either form.
 */
export function resolvePreferenceKey(list: PreferenceList, label: string): string | null {
  if (list !== "allergy" && list !== "sensitivity") return null;
  const index = list === "allergy" ? ALLERGY_INDEX : SENSITIVITY_INDEX;
  const catalogKeys: readonly string[] = list === "allergy" ? ALLERGEN_KEYS : [...SENSITIVITY_BY_KEY.keys()];
  const raw = normalizeSpoken(label);
  if (!raw) return null;
  const asKey = raw.replace(/ /g, "_");
  if (catalogKeys.includes(asKey)) return asKey;
  const candidates = [raw];
  const words = raw.split(" ");
  if (words.length > 1 && STRIP_LEADING.includes(words[0]!)) candidates.push(words.slice(1).join(" "));
  for (const candidate of candidates) {
    const key = index.get(candidate);
    if (key) return key;
  }
  return null;
}
