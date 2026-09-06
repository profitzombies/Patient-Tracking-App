import type { CatalogItem } from "./store";

interface ReviewedIdentity {
  displayName: string;
  aliases: string[];
  priority: number;
}

/** Reviewed patient-facing identities; canonical USDA descriptions stay in storage. */
export const REVIEWED_USDA_IDENTITIES: Readonly<Record<string, ReviewedIdentity>> = {
  "173630": {
    displayName: "Chicken Wings, Roasted (Meat and Skin)",
    aliases: ["chicken wing", "chicken wings", "roasted chicken wings"],
    priority: 100,
  },
  "172392": {
    displayName: "Chicken Wings, Roasted (Meat Only)",
    aliases: ["chicken wing", "chicken wings", "roasted chicken wings", "skinless chicken wings"],
    priority: 90,
  },
  "172390": {
    displayName: "Chicken Wings, Raw (Meat and Skin)",
    aliases: ["chicken wing", "chicken wings", "raw chicken wings"],
    priority: 80,
  },
  "172391": {
    displayName: "Chicken Wings, Fried (Meat Only)",
    aliases: ["chicken wing", "chicken wings", "fried chicken wings"],
    priority: 70,
  },
  "173628": {
    displayName: "Chicken Wings, Battered and Fried",
    aliases: ["chicken wing", "chicken wings", "fried chicken wings", "battered chicken wings"],
    priority: 60,
  },
  "171523": {
    displayName: "Rotisserie Chicken Wings (Meat and Skin)",
    aliases: ["chicken wing", "chicken wings", "rotisserie chicken wings"],
    priority: 50,
  },
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function catalogDisplay(item: CatalogItem): {
  name: string;
  canonicalName?: string;
  matchPriority: number;
} {
  if (item.source !== "usda_fdc") return { name: item.name, matchPriority: 0 };
  const identity = REVIEWED_USDA_IDENTITIES[item.source_id];
  return identity
    ? { name: identity.displayName, canonicalName: item.name, matchPriority: identity.priority }
    : { name: item.name, matchPriority: 0 };
}

export function patientFriendlyCatalogOrder(items: CatalogItem[], query: string): CatalogItem[] {
  const clean = normalize(query);
  return items
    .map((item, index) => {
      const identity = item.source === "usda_fdc" ? REVIEWED_USDA_IDENTITIES[item.source_id] : undefined;
      const exactAlias = identity?.aliases.some(alias => normalize(alias) === clean) ?? false;
      const displayStarts = identity ? normalize(identity.displayName).startsWith(clean) : false;
      return { item, index, score: (exactAlias ? 10_000 : 0) + (displayStarts ? 1_000 : 0) + (identity?.priority ?? 0) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(row => row.item);
}