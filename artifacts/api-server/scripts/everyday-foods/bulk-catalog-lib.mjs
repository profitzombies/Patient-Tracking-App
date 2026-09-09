import { createHash } from "node:crypto";

export const VERSION = "bulk-catalog-v1";
export const BASELINE = Object.freeze({ eligible: 5278, reviewed: 157, families: 112 });
export const TARGET_ADDITIONAL = 1163;
export const CATEGORIES = Object.freeze([
  "proteins", "seafood", "vegetables", "fruits", "grains",
  "legumes", "dairy", "nuts/seeds", "condiments", "beverages",
]);

const SOURCE_CATEGORY = new Map([
  ["Beef Products", "proteins"], ["Pork Products", "proteins"],
  ["Poultry Products", "proteins"], ["Lamb, Veal, and Game Products", "proteins"],
  ["Sausages and Luncheon Meats", "proteins"],
  ["Finfish and Shellfish Products", "seafood"],
  ["Vegetables and Vegetable Products", "vegetables"],
  ["Fruits and Fruit Juices", "fruits"],
  ["Cereal Grains and Pasta", "grains"], ["Baked Products", "grains"],
  ["Breakfast Cereals", "grains"], ["Legumes and Legume Products", "legumes"],
  ["Dairy and Egg Products", "dairy"], ["Nut and Seed Products", "nuts/seeds"],
  ["Spices and Herbs", "condiments"], ["Fats and Oils", "condiments"],
  ["Soups, Sauces, and Gravies", "condiments"], ["Beverages", "beverages"],
]);

export const QUOTAS = Object.freeze({
  proteins: 100, seafood: 90, vegetables: 115, fruits: 115, grains: 110,
  legumes: 95, dairy: 100, "nuts/seeds": 65, condiments: 50, beverages: 40,
});

const GENERIC_FIRST = new Set([
  "beef", "pork", "lamb", "veal", "chicken", "turkey", "duck", "fish",
  "mollusks", "crustaceans", "beans", "peas", "nuts", "seeds", "squash",
  "mushrooms", "peppers", "potatoes", "cheese", "milk", "yogurt", "egg",
  "rice", "pasta", "noodles", "bread", "cookies", "crackers", "cake",
  "pie", "soup", "sauce", "gravy", "oil", "spices", "beverages",
  "cereals ready-to-eat", "cereals",
]);

const BLOCKED = /\b(babyfood|infant|school lunch|restaurant|formula|imitation|substitute|industrial|commodity|usda|with added nutrients)\b/i;
const BRAND = /\b(campbell'?s|malt-o-meal|general mills|continental mills|kellogg'?s|post |quaker|kraft|oscar mayer|hormel|pepperidge farm|pillsbury|archway|barbara'?s|nature'?s path|bull'?s-eye|kc masterpiece|vitasoy|mori-nu|glutino|udi'?s|smart soup|lean pockets|hot pockets)\b/i;
const OBSCURE = /\b(carcass|spleen|thymus|pancreas|brain|lungs|testicles|seal|whale|walrus|bear|opossum|raccoon|beaver|muskrat|squirrel|prairie dog|sea lion|abiyuch|rowal|human milk|game meat|people with diabetes)\b/i;
const AMBIGUOUS_IDENTITY = /^(beverage|carbonated|fat|formulated|food|nutritional supplement|protein supplement|dessert topping|cream substitute|butter replacement)$/i;

const title = value => value.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase())
  .replace(/\bAnd\b/g, "and").replace(/\bOr\b/g, "or").replace(/\bWith\b/g, "with");
export const slug = value => value.toLowerCase().replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clean = value => value.trim().replace(/\s+/g, " ");

export function identityParts(record) {
  const parts = record.description.split(",").map(clean).filter(Boolean);
  const first = parts[0].toLowerCase();
  let take = GENERIC_FIRST.has(first) ? 2 : 1;
  if (["beef", "pork", "lamb", "veal"].includes(first) && parts[1]) take = 2;
  if (["fish", "mollusks", "crustaceans"].includes(first) && parts[1]) take = 2;
  if (first === "beverages" && /^(coffee|tea)$/i.test(parts[1] ?? "") && parts[2]) take = 3;
  const selected = parts.slice(0, take);
  let name;
  const trailingType = new Set([
    "beans", "peas", "cheese", "bread", "soup", "sauce", "gravy", "oil", "rice",
    "pasta", "noodles", "milk", "yogurt", "squash", "mushrooms", "peppers", "potatoes",
  ]);
  const poultryPart = ["breast", "thigh", "wing", "drumstick", "leg", "back", "dark meat", "light meat"]
    .map(term => ({ term, index: parts.findIndex((part, index) => index > 0 && part.toLowerCase() === term) }))
    .filter(value => value.index > 0).sort((a, b) => a.index - b.index)[0];
  const redMeatPart = ["tenderloin", "spareribs", "shoulder", "belly", "ground", "loin", "ribs", "leg"]
    .map((term, priority) => ({ term, priority, index: parts.findIndex((part, index) =>
      index > 0 && new RegExp(`\\b${term}\\b`, "i").test(part)) }))
    .filter(value => value.index > 0).sort((a, b) => a.priority - b.priority)[0];
  let identityIndex = -1;
  if (["chicken", "turkey", "duck"].includes(first) && poultryPart) {
    name = `${title(first)} ${title(poultryPart.term)}`;
    identityIndex = poultryPart.index;
  } else if (["pork", "lamb", "veal"].includes(first) && redMeatPart) {
    name = `${title(first)} ${title(redMeatPart.term)}`;
    identityIndex = redMeatPart.index;
  } else if (["beef", "pork", "lamb", "veal", "chicken", "turkey", "duck"].includes(first)) {
    name = `${title(selected[0])} ${title(selected[1] ?? "")}`;
  } else if (trailingType.has(first) && selected[1]) {
    name = `${title(selected[1])} ${title(selected[0])}`;
  } else if (first === "spices" && /^pepper$/i.test(parts[1] ?? "") && parts[2]) {
    name = `${title(parts[2])} Pepper`;
    take = 3;
  } else if (["fish", "mollusks", "crustaceans", "nuts", "seeds", "spices", "beverages",
      "cereals ready-to-eat", "cereals"].includes(first)) {
    name = title(selected.slice(1).join(" ") || selected[0]);
  } else {
    name = title(selected.join(" "));
  }
  name = clean(name).replace(/\s+\([^)]*$/g, "");
  if (first === "nuts" && /^Coconut Milk$/i.test(name)) name = "Culinary Coconut Milk";
  if (first === "nuts" && /^Cashew Nuts$/i.test(name)) name = "Cashews";
  if (["chicken", "turkey"].includes(first) && /^ground$/i.test(parts[1] ?? "")) {
    name = `Ground ${title(first)}`;
  }
  if (first === "chicken" && /^stewing$/i.test(parts[1] ?? "")) name = "Stewing Chicken";
  if (first === "beef" && /^cured$/i.test(parts[1] ?? "") && parts[2]) {
    name = `Beef ${title(parts[2])}`;
    take = 3;
  }
  if (first === "pork" && /^cured$/i.test(parts[1] ?? "") && parts[2]) {
    if (/^bacon\b/i.test(parts[2])) name = "Bacon";
    else if (/^ham\b/i.test(parts[2])) name = "Ham";
    else name = `Pork ${title(parts[2])}`;
    take = 3;
  }
  if (first === "milk") {
    const text = record.description.toLowerCase();
    if (/\bbuttermilk\b/.test(text)) name = "Buttermilk";
    else if (/\bchocolate beverage\b/.test(text) || /^chocolate\b/i.test(parts[1] ?? "")) name = "Chocolate Milk";
    else if (/\bsweetened condensed\b|\bcondensed\b.*\bsweetened\b/.test(text)) name = "Sweetened Condensed Milk";
    else if (/\bevaporated\b.*\bnonfat\b|\bnonfat\b.*\bevaporated\b/.test(text)) name = "Nonfat Evaporated Milk";
    else if (/\bevaporated\b/.test(text)) name = "Evaporated Milk";
    else if (/\bskim|nonfat|0%/.test(text)) name = "Skim Milk";
    else if (/\bwhole\b/.test(text)) name = "Whole Milk";
    else if (/\b2%|reduced fat/.test(text)) name = "2% Milk";
    else if (/\b1%|low fat/.test(text)) name = "1% Milk";
  }
  if (first === "cereals ready-to-eat" && parts[1]) {
    const grain = /^(rice|wheat|corn|oat|barley)$/i.test(parts[1]) ? title(parts[1]) : null;
    name = grain && /\bpuffed\b/i.test(record.description)
      ? `Puffed ${grain} Cereal`
      : `${title(parts[1])}${/\bcereal\b/i.test(parts[1]) ? "" : " Cereal"}`;
  }
  if (first === "beverages" && /^carbonated beverage$/i.test(parts[1] ?? "")) {
    const flavor = parts[2]?.replace(/-flavored/i, "").replace(/\bwith\b.*$/i, "").trim();
    name = flavor ? `${title(flavor)} Soda` : "Soda";
  }
  if (first === "carbonated beverage" && parts[1]) {
    name = `${title(parts[1].replace(/-flavored/i, "").replace(/\bsoda\b/i, "").trim())} Soda`;
    take = 2;
  }
  if (/\bsprouted\b/i.test(record.description)) {
    const sproutBase = name.replace(/\b(Seeds?|Beans?)\b/gi, "").trim()
      .replace(/s$/i, "");
    name = `${title(sproutBase)} Sprouts`;
  }
  const summaryParts = parts.filter((_, index) => index !== 0 && index !== identityIndex &&
    !(identityIndex < 0 && index < take));
  return { name, consumed: take, parts, summaryParts };
}

function dimensions(description) {
  const text = description.toLowerCase();
  const result = {};
  if (/\b(raw|unprepared|uncooked)\b/.test(text)) result.state = "raw";
  else if (/\b(cooked|baked|broiled|roasted|grilled|fried|boiled|steamed|poached|braised)\b/.test(text)) result.state = "cooked";
  else if (/\bcanned\b/.test(text)) result.state = "prepared";
  else if (/\b(dry|dried)\b/.test(text)) result.state = "dry";
  const preparation = ["pan-fried", "stir-fried", "deep-fried", "baked", "broiled", "roasted",
    "grilled", "fried", "boiled", "steamed", "poached", "braised"].find(x => text.includes(x));
  if (preparation) result.preparation = preparation;
  if (/\bfrozen\b/.test(text)) result.form = "frozen";
  else if (/\bcanned\b/.test(text)) result.form = "canned";
  else if (/\bdried\b/.test(text)) result.form = "dried";
  if (/\bskinless|without skin|skin not eaten\b/.test(text)) result.skin = "not eaten";
  else if (/\bwith skin|skin eaten\b/.test(text)) result.skin = "eaten";
  if (/\bwithout salt|no salt|no added salt|unsalted\b/.test(text)) result.salt = "none added";
  else if (/\bwith salt|salt added|salted\b/.test(text)) result.salt = "added";
  const lean = text.match(/\b(80|85|90|93|95)% lean(?: meat)?\s*\/?\s*(\d{1,2})% fat\b/);
  if (lean) result.leanness = `${lean[1]}% lean / ${lean[2]}% fat`;
  if (/\bwhole milk\b/.test(text) || /^milk,.*\bwhole\b/.test(text)) result["fat level"] = "whole milk";
  else if (/\b(skim|nonfat|fat free|0%)\b/.test(text)) result["fat level"] = "nonfat";
  else if (/\b(1%|low fat|lowfat)\b/.test(text)) result["fat level"] = "low fat";
  else if (/\b(2%|reduced fat)\b/.test(text)) result["fat level"] = "reduced fat";
  if (/\bsweetened condensed\b|\bcondensed\b.*\bsweetened\b/.test(text)) result.type = "sweetened condensed";
  else if (/\bevaporated\b/.test(text)) result.type = "evaporated";
  if (/\bready-to-eat\b/.test(text)) result.form = "ready-to-eat";
  if (/\bsprouted\b/.test(text)) result.form = "sprouted";
  if (/\bchocolate\b/.test(text) && /\bmilk\b/.test(text)) result.flavor = "chocolate";
  return result;
}

const UNCOUNTABLE = /\b(asparagus|bass|couscous|molasses|rice|pasta|salmon|tuna|trout|cod|tilapia|shrimp|sheep|deer|bison|water|coffee|tea|milk|butter|cheese|tofu|tempeh|hummus|mayonnaise|mustard|relish|barley|corn|spinach|fruit|juice)$/i;
const CATEGORY_QUALIFIER = {
  proteins: "protein", seafood: "seafood", vegetables: "vegetable", fruits: "fruit",
  grains: "grain", legumes: "legume", dairy: "dairy food", "nuts/seeds": "nut or seed",
  condiments: "condiment", beverages: "drink",
};

function aliases(name, category) {
  const lower = name.toLowerCase();
  const values = [lower];
  if (UNCOUNTABLE.test(lower)) values.push(`${lower} ${CATEGORY_QUALIFIER[category]}`);
  else if (lower.endsWith("ies")) values.push(`${lower.slice(0, -3)}y`);
  else if (lower.endsWith("leaves")) values.push(`${lower.slice(0, -6)}leaf`);
  else if (/(ches|shes|xes|zes|oes)$/.test(lower)) values.push(lower.slice(0, -2));
  else if (/(cheeses|sauces|beverages)$/.test(lower)) values.push(lower.slice(0, -1));
  else if (lower.endsWith("s") && !/(ss|us|is)$/.test(lower)) values.push(lower.slice(0, -1));
  else if (/[^aeiou]y$/.test(lower)) values.push(`${lower.slice(0, -1)}ies`);
  else if (/(s|x|z|ch|sh)$/.test(lower)) values.push(`${lower}es`);
  else values.push(`${lower}s`);
  return [...new Set(values)];
}

const normalizedIdentityContract = value => value.toLowerCase()
  .replace(/[^a-z0-9%/]+/g, " ").trim().replace(/\s+/g, " ");

export function findQueryOwnershipConflicts(manifest, queryCases, familyRedirects = []) {
  const redirects = new Map(familyRedirects.map(row =>
    [row.historicalFamily, row.canonicalFamily]));
  const canonical = familyKey => redirects.get(familyKey) ?? familyKey;
  const claims = new Map();
  const addClaim = (query, familyKey, evidence) => {
    if (!query || !familyKey) return;
    const normalizedQuery = normalizedIdentityContract(query);
    if (!claims.has(normalizedQuery)) claims.set(normalizedQuery, []);
    claims.get(normalizedQuery).push({
      query, normalizedQuery, familyKey: canonical(familyKey), evidence,
    });
  };
  for (const test of queryCases) {
    addClaim(test.query, test.expectedFamily ?? test.firstFamily,
      test.expect === "family-or-honest-empty"
        ? "state-constrained corpus ownership" : "corpus ownership");
  }
  for (const family of manifest.families) {
    for (const alias of new Set([family.displayName, ...(family.aliases ?? [])])) {
      addClaim(alias, family.familyKey, "generated canonical/alias ownership");
    }
  }
  return [...claims.entries()].flatMap(([normalizedQuery, rows]) => {
    const owners = [...new Set(rows.map(row => row.familyKey))];
    if (owners.length < 2) return [];
    return [{
      normalizedQuery,
      owners,
      claims: rows.sort((a, b) =>
        a.familyKey.localeCompare(b.familyKey) || a.evidence.localeCompare(b.evidence)),
      reason: "one normalized literal query has contradictory family ownership; modifier words are not stripped or auto-merged",
    }];
  }).sort((a, b) => a.normalizedQuery.localeCompare(b.normalizedQuery));
}

function candidate(record, occupiedAliases, existingByKey) {
  const category = SOURCE_CATEGORY.get(record.foodCategory);
  if (!category) return { accepted: false, reason: "outside ten-category bulk scope" };
  if (BLOCKED.test(record.description)) return { accepted: false, reason: "specialized or unsuitable generic identity" };
  if (record.portions.some(portion => {
    const sourceUnit = portion.unit && !/^undetermined$/i.test(portion.unit)
      ? portion.unit : (portion.modifier || portion.description || "serving");
    const descriptor = portion.description || portion.modifier || portion.unit || "";
    return sourceUnit.length > 40 || descriptor.length > 150;
  })) {
    return { accepted: false, reason: "canonical helper source portion exceeds the strict snapshot wire bounds" };
  }
  if (BRAND.test(record.description) || /\b[A-Z]{3,}\b/.test(record.description)) {
    return { accepted: false, reason: "brand-specific record remains in separate exact singleton search" };
  }
  if (OBSCURE.test(record.description)) return { accepted: false, reason: "lower everyday usefulness than reviewed quota candidates" };
  const identity = identityParts(record);
  if (!identity.name || identity.name.length < 3 || /^(food|product|other)$/i.test(identity.name)) {
    return { accepted: false, reason: "identity cannot be made specific without interpretation" };
  }
  if (AMBIGUOUS_IDENTITY.test(identity.name) || /\balcoholic beverages?\b/i.test(identity.name) ||
      /\b(liquid from|composite of|retail cuts?|variety meats?|by-products?)\b/i.test(identity.name) ||
      /\b(human milk|meal supplement|broilers? or fryers?|chicken roasting|pork fresh|lamb (new zealand|australian)|all classes)\b/i.test(identity.name) ||
      /'s$/i.test(identity.name)) {
    return { accepted: false, reason: "generic, alcoholic, or manufacturer-like identity is not prioritized for the everyday batch" };
  }
  if (category === "legumes" && /\b(bacon|frankfurter|sausage|luncheon|sandwich spread|meatless|meat extender|noodles?)\b/i.test(identity.name)) {
    return { accepted: false, reason: "legume-based imitation or noodle is not the familiar identity named by its source heading" };
  }
  let proposedAliases = aliases(identity.name, category);
  const owners = new Set(proposedAliases
    .map(alias => occupiedAliases.get(normalizedIdentityContract(alias))).filter(Boolean));
  if (owners.size > 1) return { accepted: false, reason: "aliases cross multiple existing identity contracts" };
  const existing = owners.size ? existingByKey.get([...owners][0]) : null;
  if (existing && ((existing.familyKey === "meatballs" && /\bmeatless\b/i.test(record.description)) ||
      (existing.familyKey === "rice" && /\bcereals? ready-to-eat\b/i.test(record.description)))) {
    return { accepted: false, reason: "source is a false friend of an existing identity contract" };
  }
  if (existing) proposedAliases = existing.aliases;
  const rest = identity.summaryParts;
  const summary = rest.length ? title(rest.join(" · ")) : "Generic source record";
  const canonicalAlias = existing ? existing.aliases[0] :
    [...proposedAliases].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return {
    accepted: true, category, familyKey: existing?.familyKey ?? `bulk-${slug(canonicalAlias)}`,
    displayName: existing?.displayName ?? identity.name, aliases: proposedAliases, summary,
    existingFamily: Boolean(existing), existingMaxCommonOrder: existing?.maxCommonOrder ?? 0,
    dimensions: dimensions(record.description),
  };
}

const USEFUL = {
  proteins: /\b(chicken|turkey|beef|pork|ham|bacon|sausage|lamb|veal|bison|duck)\b/i,
  seafood: /\b(salmon|tuna|shrimp|cod|tilapia|trout|crab|lobster|sardine|scallop|clam|oyster|mussel|halibut|haddock|catfish|anchovy|mackerel)\b/i,
  vegetables: /\b(broccoli|bean|potato|carrot|spinach|cauliflower|asparagus|zucchini|cucumber|squash|corn|pea|tomato|pepper|onion|mushroom|cabbage|lettuce|beet|celery)\b/i,
  fruits: /\b(apple|orange|strawberr|blueberr|grape|pear|peach|pineapple|watermelon|mango|avocado|banana|cherr|raspberr|blackberr|plum|melon|kiwi|lemon|lime|grapefruit)\b/i,
  grains: /\b(oat|rice|bread|pasta|noodle|barley|quinoa|cornmeal|couscous|tortilla|bagel|muffin|wheat|rye|cereal|spaghetti|macaroni)\b/i,
  legumes: /\b(bean|lentil|pea|chickpea|soy|tofu|tempeh|hummus|peanut|edamame)\b/i,
  dairy: /\b(milk|cheese|yogurt|egg|cream|butter|kefir|ricotta|mozzarella|cheddar)\b/i,
  "nuts/seeds": /\b(almond|walnut|cashew|pistachio|pecan|sunflower|pumpkin|chia|sesame|peanut|hazelnut|flax|coconut|chestnut)\b/i,
  condiments: /\b(mustard|mayonnaise|sauce|salsa|vinegar|relish|dressing|oil|spice|pepper|salt|gravy|broth|soup)\b/i,
  beverages: /\b(water|coffee|tea|juice|lemonade|cocoa|milk|drink|punch|smoothie)\b/i,
};
const COMMON_SINGLETON = /\b(apple|banana|orange|lemon|lime|grape|pear|peach|plum|melon|mango|avocado|berry|broccoli|carrot|spinach|potato|tomato|onion|garlic|corn|cabbage|lettuce|celery|asparagus|zucchini|salmon|tuna|shrimp|cod|trout|crab|lobster|chicken|turkey|beef|pork|ham|bacon|rice|oat|bread|pasta|noodle|tortilla|bean|lentil|pea|chickpea|tofu|milk|cheese|yogurt|egg|butter|almond|walnut|cashew|pecan|peanut|mustard|mayonnaise|salsa|vinegar|coffee|tea|water|juice)\b/i;

export function buildManifest(source, existingFamilies, consumerRejectedSourceIds = new Set()) {
  if (source.frozen.eligible !== BASELINE.eligible ||
      source.frozen.reviewed !== BASELINE.reviewed ||
      source.frozen.families !== BASELINE.families) {
    throw new Error(`frozen baseline mismatch: ${JSON.stringify(source.frozen)}`);
  }
  const existingByKey = new Map(existingFamilies.map(f => [f.familyKey, f]));
  const occupiedAliases = new Map(existingFamilies.flatMap(f =>
    f.aliases.map(alias => [normalizedIdentityContract(alias), f.familyKey])));
  const prepared = source.records.map(record => ({
    record, decision: candidate(record, occupiedAliases, existingByKey),
  }));
  let accepted = [];
  const accept = ({ record, decision }) => ({
    sourceId: String(record.fdcId), releaseId: record.releaseId,
    catalogId: record.catalogId, canonicalName: record.description,
    canonicalRawMd5: record.rawMd5, familyKey: decision.familyKey,
    displayName: decision.displayName, aliases: decision.aliases,
    category: decision.category, summary: decision.summary, dimensions: decision.dimensions,
    sourcePortions: record.portions, existingFamily: decision.existingFamily,
    existingMaxCommonOrder: decision.existingMaxCommonOrder,
    acceptanceEvidence: [
      "catalog row was frozen as eligible safe_singleton",
      "immutable ready-release source and raw-record MD5 are pinned",
      "family identity follows category-specific noun order and meat-part extraction rules",
      "variant summary is the remaining canonical-description clauses",
      "dimensions are asserted only by literal controlled source terms",
      "nutrition and portions will be copied by the canonical database snapshot helper",
      "source portion labels and semantic units fit the strict mobile snapshot wire bounds",
      "aliases either preserve a pre-batch identity contract or do not collide with one",
    ],
  });
  for (const category of CATEGORIES) {
    const pool = prepared.filter(x => x.decision.accepted && x.decision.category === category);
    const groups = new Map();
    for (const item of pool) {
      const key = item.decision.familyKey;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [key, rows] of groups) {
      if (!rows[0].decision.existingFamily && rows.length < 2 &&
          !COMMON_SINGLETON.test(rows[0].decision.displayName)) groups.delete(key);
    }
    for (const rows of groups.values()) rows.sort((a, b) => a.record.description.localeCompare(b.record.description) || a.record.fdcId - b.record.fdcId);
    const orderedGroups = [...groups.entries()].sort((a, b) => {
      const score = ([, rows]) => (rows[0].decision.existingFamily ? 1000 : 0) +
        (USEFUL[category].test(rows[0].decision.displayName) ? 100 : 0);
      return score(b) - score(a) || a[0].localeCompare(b[0]);
    });
    const desired = Math.min(QUOTAS[category],
      orderedGroups.reduce((sum, [, rows]) => sum + rows.length, 0));
    let cursor = 0;
    while (accepted.filter(x => x.category === category).length < desired) {
      let progressed = false;
      for (const [, rows] of orderedGroups) {
        if (rows[cursor]) {
          accepted.push(accept(rows[cursor]));
          progressed = true;
          if (accepted.filter(x => x.category === category).length === desired) break;
        }
      }
      if (!progressed) break;
      cursor++;
    }
  }
  // Category ceilings establish broad coverage first. Fill only with additional
  // exact variants of those already accepted identities, round-robin and capped,
  // rather than introducing lower-priority one-record technical headings.
  const acceptedIdsBeforeFill = new Set(accepted.map(row => row.catalogId));
  const acceptedFamilies = new Set(accepted.map(row => row.familyKey));
  const extrasByFamily = new Map();
  for (const item of prepared) {
    if (!item.decision.accepted || acceptedIdsBeforeFill.has(item.record.catalogId) ||
        !acceptedFamilies.has(item.decision.familyKey)) continue;
    if (!extrasByFamily.has(item.decision.familyKey)) extrasByFamily.set(item.decision.familyKey, []);
    extrasByFamily.get(item.decision.familyKey).push(item);
  }
  for (const rows of extrasByFamily.values()) rows.sort((a, b) => {
    const aDimensions = Object.keys(a.decision.dimensions).length;
    const bDimensions = Object.keys(b.decision.dimensions).length;
    return bDimensions - aDimensions ||
      a.record.description.localeCompare(b.record.description) || a.record.fdcId - b.record.fdcId;
  });
  const familyOrder = [...extrasByFamily.keys()].sort((a, b) => a.localeCompare(b));
  const familyCounts = new Map([...acceptedFamilies].map(key => [
    key, accepted.filter(row => row.familyKey === key).length,
  ]));
  let fillCursor = 0;
  while (accepted.length < TARGET_ADDITIONAL) {
    let progressed = false;
    for (const familyKey of familyOrder) {
      const next = extrasByFamily.get(familyKey)[fillCursor];
      if (!next || familyCounts.get(familyKey) >= 12) continue;
      accepted.push(accept(next));
      familyCounts.set(familyKey, familyCounts.get(familyKey) + 1);
      progressed = true;
      if (accepted.length === TARGET_ADDITIONAL) break;
    }
    if (!progressed) break;
    fillCursor++;
  }
  accepted = accepted.filter(row => !consumerRejectedSourceIds.has(row.sourceId));
  const acceptedIds = new Set(accepted.map(x => x.catalogId));
  const rejected = prepared.filter(x => !acceptedIds.has(x.record.catalogId)).map(({ record, decision }) => ({
    sourceId: String(record.fdcId), releaseId: record.releaseId, catalogId: record.catalogId,
    canonicalName: record.description, category: decision.category ?? null,
    familyKey: decision.familyKey ?? null, displayName: decision.displayName ?? null,
    reason: consumerRejectedSourceIds.has(String(record.fdcId))
      ? "canonical live snapshot helper output is rejected by the strict mobile parser"
      : decision.accepted ? "valid but not selected: target reached after bounded common-family variant ordering" : decision.reason,
  }));
  const familyMap = new Map();
  for (const row of accepted) {
    if (!row.existingFamily && !familyMap.has(row.familyKey)) familyMap.set(row.familyKey, {
      familyKey: row.familyKey, displayName: row.displayName, aliases: row.aliases, category: row.category,
    });
  }
  accepted.sort((a, b) => a.familyKey.localeCompare(b.familyKey) || a.canonicalName.localeCompare(b.canonicalName) || Number(a.sourceId) - Number(b.sourceId));
  accepted.forEach((row, index, rows) => {
    row.commonOrder = row.existingMaxCommonOrder +
      rows.slice(0, index).filter(other => other.familyKey === row.familyKey).length + 1;
  });
  const rawDigest = createHash("sha256").update(source.records.map(x => `${x.releaseId}:${x.fdcId}:${x.rawMd5}`).join("\n")).digest("hex");
  return {
    version: VERSION,
    frozenBaseline: { ...BASELINE, eligibleSingletons: source.records.length, quarterTarget: 1320, additionalRequired: TARGET_ADDITIONAL, orderedSourceDigestSha256: rawDigest },
    policy: {
      nutrition: "No generated nutrition. Migration invokes build_food_catalog_source_snapshot for each exact release and source ID.",
      selection: "Broad category floors are followed by bounded round-robin variants of accepted common identities; no lower-priority one-record heading is introduced during target fill.",
      aliases: "Bounded morphology with uncountable exceptions; equivalent existing identities append variants without changing their defaults or aliases.",
      confidence: "Acceptance is the conjunction of acceptanceEvidence assertions, never a numeric confidence score.",
    },
    families: [...familyMap.values()].sort((a, b) => a.familyKey.localeCompare(b.familyKey)),
    accepted, rejected,
  };
}

export function validateManifest(manifest, source, existingFamilies) {
  const errors = [];
  const sourceByCatalog = new Map(source.records.map(x => [x.catalogId, x]));
  const priorKeys = new Set(existingFamilies.map(x => x.familyKey));
  const aliasOwner = new Map(existingFamilies.flatMap(x => x.aliases.map(a => [a.toLowerCase(), x.familyKey])));
  const ids = new Set(), revisions = new Set();
  for (const row of manifest.accepted) {
    const sourceRow = sourceByCatalog.get(row.catalogId);
    if (!sourceRow) errors.push(`${row.catalogId}: not in frozen singleton set`);
    if (ids.has(row.catalogId)) errors.push(`${row.catalogId}: duplicate catalog row`);
    ids.add(row.catalogId);
    const revision = `${row.releaseId}:${row.sourceId}`;
    if (revisions.has(revision)) errors.push(`${revision}: duplicate source revision`);
    revisions.add(revision);
    if (sourceRow && (String(sourceRow.fdcId) !== row.sourceId || sourceRow.releaseId !== row.releaseId ||
      sourceRow.description !== row.canonicalName || sourceRow.rawMd5 !== row.canonicalRawMd5)) {
      errors.push(`${revision}: source evidence mismatch`);
    }
    if (priorKeys.has(row.familyKey) !== Boolean(row.existingFamily)) {
      errors.push(`${row.familyKey}: existing-family disposition mismatch`);
    }
    if (!row.acceptanceEvidence?.length) errors.push(`${revision}: missing evidence assertions`);
    const canonical = row.canonicalName.toLowerCase();
    if (/^milk,\s*chocolate\b|\bchocolate beverage\b/.test(canonical) &&
        (!/chocolate milk/i.test(row.displayName) || row.dimensions.flavor !== "chocolate")) {
      errors.push(`${revision}: chocolate milk flavor identity was dropped`);
    }
    if (/\bmilk\b/.test(canonical) && /\b(whole|skim|nonfat|lowfat|low fat|reduced fat|1%|2%)\b/.test(canonical) &&
        !row.dimensions["fat level"]) {
      errors.push(`${revision}: milk fat class was dropped`);
    }
    if (/\bcereals? ready-to-eat\b/.test(canonical) &&
        (!/cereal/i.test(row.displayName) || row.dimensions.form !== "ready-to-eat")) {
      errors.push(`${revision}: ready-to-eat cereal collapsed into a raw grain identity`);
    }
    if (/\bsprouted\b/.test(canonical) &&
        (!/sprouts/i.test(row.displayName) || row.dimensions.form !== "sprouted")) {
      errors.push(`${revision}: sprout identity collapsed into mature seed/legume family`);
    }
    for (const alias of row.aliases) {
      const owner = aliasOwner.get(alias.toLowerCase());
      if (owner && owner !== row.familyKey) errors.push(`${row.familyKey}: alias ${alias} belongs to ${owner}`);
      aliasOwner.set(alias.toLowerCase(), row.familyKey);
    }
  }
  const categoryCounts = Object.fromEntries(CATEGORIES.map(category => [
    category, manifest.accepted.filter(x => x.category === category).length,
  ]));
  for (const category of CATEGORIES) if (categoryCounts[category] < QUOTAS[category]) errors.push(`${category}: broad-coverage floor not met`);
  if (ids.size + manifest.rejected.length !== source.records.length) errors.push("accepted/rejected sets do not reconcile");
  return {
    valid: errors.length === 0, errors, acceptedRecords: ids.size,
    families: new Set(manifest.accepted.map(x => x.familyKey)).size,
    rejected: manifest.rejected.length, unresolved: 0, categoryCounts,
    frozenDenominator: BASELINE.eligible, reviewedAfter: BASELINE.reviewed + ids.size,
    shortfall: Math.max(0, TARGET_ADDITIONAL - ids.size),
    coverage: (BASELINE.reviewed + ids.size) / BASELINE.eligible,
  };
}