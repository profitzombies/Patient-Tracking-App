import fs from "node:fs";
import path from "node:path";

/**
 * Knowledge compartments for the THINNR coach.
 *
 * Every compartment is a verbatim slice of the docs archive, read from disk at
 * runtime. Nothing is copied or reworded here: the manual is sliced by its
 * `--- Page N ---` markers and the knowledge base by its section headings, so
 * the model always sees the official wording exactly as transcribed.
 */

export interface Compartment {
  id: string;
  title: string;
  /** Regex patterns scored against the user's message to select compartments. */
  keywords: RegExp[];
  /** Loads the verbatim source text (cached after first read). */
  load: () => string;
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    }
    dir = parent;
  }
}

const repoRoot = findRepoRoot();
const docsDir = path.join(repoRoot, "docs", "thinnr-program");

function readDoc(relPath: string): string {
  return fs.readFileSync(path.join(docsDir, relPath), "utf8");
}

/** Splits the manual transcription into a page-number -> page-text map. */
function manualPages(): Map<number, string> {
  const raw = readDoc("manual-transcription.md");
  const pages = new Map<number, string>();
  const marker = /^--- Page (\d+) ---$/gm;
  let match: RegExpExecArray | null;
  let prevPage: number | null = null;
  let prevStart = 0;
  while ((match = marker.exec(raw)) !== null) {
    if (prevPage !== null) {
      pages.set(prevPage, raw.slice(prevStart, match.index).trimEnd());
    }
    prevPage = Number(match[1]);
    prevStart = match.index;
  }
  if (prevPage !== null) {
    pages.set(prevPage, raw.slice(prevStart).trimEnd());
  }
  return pages;
}

let cachedPages: Map<number, string> | null = null;
function pageRange(from: number, to: number): string {
  cachedPages ??= manualPages();
  const parts: string[] = [];
  for (let n = from; n <= to; n++) {
    const text = cachedPages.get(n);
    if (text) parts.push(text);
  }
  if (parts.length === 0) {
    throw new Error(`Manual pages ${from}-${to} not found in transcription`);
  }
  return parts.join("\n\n");
}

/** Knowledge-base section headings, exactly as they appear in the file. */
const KB_HEADINGS = [
  "THINNR PROTOCOL PROGRAM QUESTIONS",
  "WEIGHT LOSS",
  "THE FOODS",
  "LOTIONS, SUNBLOCK, COSMETICS/MAKEUP",
  "MEDICATION INTERACTIONS",
  "THINNR PROTOCOL USE WITH PATIENTS WITH EXISTING CONDITIONS",
  "FINANCIAL QUESTIONS",
  "MISCELLANEOUS QUESTIONS",
] as const;

type KbHeading = (typeof KB_HEADINGS)[number];

let cachedKbSections: Map<string, string> | null = null;
/** Slices the knowledge base into sections keyed by heading ("" = intro). */
function kbSections(): Map<string, string> {
  if (cachedKbSections) return cachedKbSections;
  const lines = readDoc("protocol-knowledge-base.txt").split("\n");
  const headingSet = new Set<string>(KB_HEADINGS);
  const boundaries: Array<{ heading: string; index: number }> = [{ heading: "", index: 0 }];
  lines.forEach((line, index) => {
    if (headingSet.has(line.trim())) boundaries.push({ heading: line.trim(), index });
  });
  const sections = new Map<string, string>();
  boundaries.forEach((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : lines.length;
    sections.set(b.heading, lines.slice(b.index, end).join("\n").trim());
  });
  cachedKbSections = sections;
  return sections;
}

function kbSection(...headings: KbHeading[]): string {
  const sections = kbSections();
  const parts = headings.map((h) => {
    const text = sections.get(h);
    if (!text) throw new Error(`Knowledge base section not found: ${h}`);
    return text;
  });
  return parts.join("\n\n");
}

/** Intro (homeopathy explanation) + program questions read together. */
function kbIntroAndProgram(): string {
  const intro = kbSections().get("") ?? "";
  return [intro, kbSection("THINNR PROTOCOL PROGRAM QUESTIONS")].filter(Boolean).join("\n\n");
}

interface RestaurantQuote {
  question?: string;
  lines: string[];
  source: string;
}

/**
 * The restaurant guide JSON mixes verbatim program quotes with editorial UI
 * metadata (section keys/titles). Only the verbatim fields — the quoted
 * question, the quoted lines, and the source attribution — are passed to the
 * model, so the grounding text stays official program wording.
 */
function loadRestaurantGuide(): string {
  const raw = fs.readFileSync(
    path.join(repoRoot, "artifacts", "thinnr-mobile", "data", "restaurant-guide.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as { sections?: Array<{ quotes?: RestaurantQuote[] }> };
  const blocks: string[] = [];
  for (const section of parsed.sections ?? []) {
    for (const quote of section.quotes ?? []) {
      const lines = [
        ...(quote.question ? [quote.question] : []),
        ...quote.lines,
        `(Source: ${quote.source})`,
      ];
      blocks.push(lines.join("\n"));
    }
  }
  if (blocks.length === 0) {
    throw new Error("Restaurant guide contained no quotes");
  }
  return blocks.join("\n\n");
}

const cache = new Map<string, string>();
function cached(id: string, loader: () => string): () => string {
  return () => {
    let text = cache.get(id);
    if (text === undefined) {
      text = loader();
      cache.set(id, text);
    }
    return text;
  };
}

export const COMPARTMENTS: Compartment[] = [
  {
    id: "program-phases",
    title: "Program phases and daily structure (manual pages 2-9)",
    keywords: [
      /\bphase\b/i,
      /\bday\b/i,
      /\btoday\b/i,
      /normali[sz]ation/i,
      /metabolic/i,
      /thinning/i,
      /maintenance/i,
      /\bpillar/i,
      /fasting/i,
      /breakfast|lunch|dinner|snack/i,
      /how long|how many (days|weeks)/i,
      /vegetarian|vegan/i,
      /exercise|workout/i,
      /\bwater\b/i,
      /what (should|can|do) i eat/i,
    ],
    load: cached("program-phases", () => pageRange(2, 9)),
  },
  {
    id: "approved-foods",
    title: "Approved foods list (verbatim)",
    keywords: [
      /approved|allowed|permitted|off[- ]limits|forbidden/i,
      /can i (eat|have|drink)/i,
      /is .{1,40} (ok|okay|allowed|approved|fine)/i,
      /\blist\b/i,
      /beef|steak|veal|chicken|turkey|fish|shrimp|seafood|egg/i,
      /bread|grain|melba|grissini|tortilla|cracker/i,
      /fruit|apple|orange|strawberr|grapefruit|berr(y|ies)|lemon/i,
      /vegetable|lettuce|spinach|tomato|cucumber|asparagus|broccoli|celery|onion/i,
      /coffee|tea|drink|beverage|soda|juice|milk/i,
      /sweetener|stevia|sugar|dessert/i,
      /cheese|butter|oil|dressing|sauce|condiment/i,
    ],
    load: cached("approved-foods", () => readDoc("approved-foods.md")),
  },
  {
    id: "recipes-beef",
    title: "Beef recipes (manual pages 10-17)",
    keywords: [/recipe/i, /\b(beef|steak|veal|filet|sirloin)\b/i],
    load: cached("recipes-beef", () => pageRange(10, 17)),
  },
  {
    id: "recipes-poultry",
    title: "Poultry recipes (manual pages 18-23)",
    keywords: [/recipe/i, /\b(chicken|poultry|turkey)\b/i],
    load: cached("recipes-poultry", () => pageRange(18, 23)),
  },
  {
    id: "recipes-seafood",
    title: "Seafood recipes (manual pages 24-31)",
    keywords: [/recipe/i, /\b(fish|seafood|shrimp|cod|halibut|tilapia|grouper|snapper|scallop)\b/i],
    load: cached("recipes-seafood", () => pageRange(24, 31)),
  },
  {
    id: "recipes-pork",
    title: "Pork recipes (manual pages 32-38)",
    keywords: [/recipe/i, /\b(pork|loin)\b/i],
    load: cached("recipes-pork", () => pageRange(32, 38)),
  },
  {
    id: "recipes-vegetables",
    title: "Vegetable recipes (manual pages 39-44)",
    keywords: [
      /recipe/i,
      /\b(vegetable|veggie|zucchini|eggplant|squash|brussels|cauliflower|side dish)\b/i,
    ],
    load: cached("recipes-vegetables", () => pageRange(39, 44)),
  },
  {
    id: "qa-program",
    title: "Protocol Q&A: program and dosing questions",
    keywords: [
      /\bdose|doses|dosing|drops?\b/i,
      /\btake|taking\b/i,
      /\bboost\b/i,
      /protocol/i,
      /bottle|vial/i,
      /alcohol/i,
      /side effect/i,
      /homeopath/i,
      /refrigerat|store|storage/i,
      /miss(ed)? (a )?dose/i,
      /under (the )?tongue|sublingual/i,
      /how does .{1,30} work/i,
    ],
    load: cached("qa-program", kbIntroAndProgram),
  },
  {
    id: "qa-weight-loss",
    title: "Protocol Q&A: weight loss expectations and stalls",
    keywords: [
      /plateau|stall/i,
      /not losing|stopped losing|no (weight )?loss/i,
      /gain(ed|ing)?\b/i,
      /\bscale\b|weigh[- ]in|weighing/i,
      /cheat(ed|ing)?|slip(ped)?/i,
      /how (much|fast) .{0,30}(lose|loss)/i,
      /pound|lbs?\b/i,
    ],
    load: cached("qa-weight-loss", () => kbSection("WEIGHT LOSS")),
  },
  {
    id: "qa-foods",
    title: "Protocol Q&A: food rules and clarifications",
    keywords: [
      /why (can'?t|cant|not)/i,
      /mix(ing)? vegetables/i,
      /sweetener|stevia|sugar/i,
      /seasoning|spice|salt|marinade|sauce|dressing|oil/i,
      /calorie/i,
      /gum|mints?\b/i,
      /protein (shake|powder)/i,
      /substitut/i,
    ],
    load: cached("qa-foods", () => kbSection("THE FOODS")),
  },
  {
    id: "qa-products",
    title: "Protocol Q&A: lotions, sunblock, cosmetics",
    keywords: [
      /lotion|sunblock|sunscreen|makeup|make[- ]up|cosmetic|moisturi[sz]er|shampoo|soap|deodorant|lip balm|chapstick/i,
    ],
    load: cached("qa-products", () => kbSection("LOTIONS, SUNBLOCK, COSMETICS/MAKEUP")),
  },
  {
    id: "qa-medical",
    title: "Protocol Q&A: medications and existing conditions",
    keywords: [
      /medication|medicine|prescription|\bdrug\b/i,
      /thyroid|diabet|insulin|metformin|blood pressure|cholesterol|statin/i,
      /pregnan|breastfeed|nursing/i,
      /surgery|cancer|gallbladder|cholecystitis/i,
      /\bcondition\b|\bdoctor\b|physician/i,
      /antibiotic|antidepressant|birth control/i,
    ],
    load: cached("qa-medical", () =>
      kbSection("MEDICATION INTERACTIONS", "THINNR PROTOCOL USE WITH PATIENTS WITH EXISTING CONDITIONS"),
    ),
  },
  {
    id: "qa-billing-misc",
    title: "Protocol Q&A: financial and miscellaneous questions",
    keywords: [/cost|price|refund|pay(ment)?\b/i, /insurance/i],
    load: cached("qa-billing-misc", () =>
      kbSection("FINANCIAL QUESTIONS", "MISCELLANEOUS QUESTIONS"),
    ),
  },
  {
    id: "restaurant-guide",
    title: "Restaurant and dining-out guide (verbatim quotes)",
    keywords: [
      /restaurant|dining|dine\b|eat(ing)? out/i,
      /\bmenu\b|order(ing)?\b|takeout|take[- ]out|fast food/i,
      /travel(ing|ling)?\b|on the (road|go)/i,
      /party|event|wedding|holiday/i,
    ],
    load: cached("restaurant-guide", loadRestaurantGuide),
  },
];
