/**
 * Meal-read side-by-side harness — the gate for plate-read latency knobs.
 *
 * Runs the production plate-read code path (generateMealPhotoAnalysis, same
 * prompt, same validator, same retries) over EVERY fixture plate in
 * ./fixtures at each requested reasoning effort and model tier, and writes
 * a markdown report comparing every candidate against the shipped default:
 * item sets, per-item portions/calories, totals, latency, and reasoning
 * tokens.
 *
 * Why this exists: a 2026-08 latency pass shipped reasoning_effort:"none"
 * for the plate read after ONE clean probe plate, and real-world reads
 * degraded. A single easy photo cannot represent mixed dishes, sauces that
 * hide food, or ambiguous portions — the fixture set here deliberately
 * does. The rule this harness enforces:
 *
 *   No latency knob that can touch read quality ships unless it reaches
 *   PARITY with the default read across the ENTIRE fixture set — same item
 *   sets, portions in tolerance — in a recorded run committed to results/.
 *   One clean plate is never evidence.
 *
 * Reads are stochastic: the automated verdict is a conservative aid
 * (different item names = DIFFERENT), and the full per-plate outputs are
 * recorded so a human can judge borderline wording differences. When in
 * doubt, re-run with --trials 2 and require parity on every trial.
 *
 * Usage (live model calls — costs real tokens):
 *   pnpm --filter @workspace/api-server run harness:meal-read
 *   pnpm --filter @workspace/api-server run harness:meal-read -- \
 *     --efforts default,none,low --trials 1 --out results/2026-08-27.md
 *   pnpm --filter @workspace/api-server run harness:meal-read -- \
 *     --models default,gpt-5.4-mini --out results/2026-09-18-tiers.md
 *
 * "default" means the knob is OMITTED from the request — the model's own
 * default effort, the production setting — and, for --models, the
 * production model for coach.meal_photo (src/ai/models.ts). A non-default
 * model is pinned through that surface's environment knob for the read, so
 * the candidate runs the identical code path. Candidates are labelled
 * "<effort>" on the default model and "<effort>@<model>" otherwise.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateMealPhotoAnalysis,
  type MealPhotoAnalysis,
  type MealReadReasoningEffort,
} from "../../src/coach/meal-photo";
import { createPhotoUsageLog } from "../../src/coach/usage";
import type { PatientContext } from "../../src/coach/prompt";
import { DEFAULT_MODELS, modelKnobName } from "../../src/ai/models";

/** "default" = knob omitted (production). Anything else pins the effort. */
type EffortName = "default" | MealReadReasoningEffort;

/** "default" = the production model for coach.meal_photo. */
type ModelName = string;

interface Candidate {
  effort: EffortName;
  model: ModelName;
  /** Report label: "default", "none", "default@gpt-5.4-mini", ... */
  label: string;
}

const MEAL_PHOTO_KNOB = modelKnobName("coach.meal_photo");

function candidateLabel(effort: EffortName, model: ModelName): string {
  return model === "default" ? effort : `${effort}@${model}`;
}

/** ESM package — no __dirname; everything is relative to this script. */
const HERE = dirname(fileURLToPath(import.meta.url));

const PARITY_ITEM_CAL_TOLERANCE = 0.15; // per matched item, vs default
const PARITY_TOTAL_CAL_TOLERANCE = 0.1; // meal total, vs default

/** Same fixed context for every call so effort is the only variable. */
const PATIENT: PatientContext = { firstName: "Harness", programDay: 12, phaseName: "Reset" };
const SLOT = { timeDefault: "dinner" as const, localTime: "18:30" };

interface ReadResult {
  effort: EffortName;
  model: ModelName;
  label: string;
  trial: number;
  latencyMs: number;
  reasoningTokens: number;
  promptTokens: number;
  completionTokens: number;
  modelCalls: number;
  outcome: MealPhotoAnalysis["outcome"];
  mealName: string | null;
  totalCalories: number | null;
  items: { name: string; amount: number; unit: string; calories: number }[];
  error?: string;
}

function parseArgs(): { candidates: Candidate[]; efforts: EffortName[]; models: ModelName[]; trials: number; out: string | undefined } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const efforts = (get("--efforts") ?? "default,none").split(",").map((e) => e.trim()) as EffortName[];
  const valid = new Set(["default", "none", "low", "medium", "high", "xhigh"]);
  for (const effort of efforts) {
    if (!valid.has(effort)) throw new Error(`unknown effort "${effort}"`);
  }
  if (!efforts.includes("default")) {
    throw new Error("the efforts list must include \"default\" — it is the comparison baseline");
  }
  const models = (get("--models") ?? "default").split(",").map((m) => m.trim()).filter(Boolean);
  if (!models.includes("default")) {
    throw new Error("the models list must include \"default\" — it is the comparison baseline");
  }
  const candidates: Candidate[] = [];
  for (const model of models) {
    for (const effort of efforts) {
      candidates.push({ effort, model, label: candidateLabel(effort, model) });
    }
  }
  return { candidates, efforts, models, trials: Number(get("--trials") ?? "1"), out: get("--out") };
}

function loadFixtures(): { name: string; dataUri: string }[] {
  const dir = join(HERE, "fixtures");
  const files = readdirSync(dir)
    .filter((f) => [".jpg", ".jpeg", ".png"].includes(extname(f).toLowerCase()))
    .sort();
  if (files.length < 3) {
    throw new Error(
      `only ${files.length} fixture plate(s) in ${dir} — a knob gate needs a varied set, not a single probe photo`,
    );
  }
  return files.map((f) => {
    const mime = extname(f).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
    const b64 = readFileSync(join(dir, f)).toString("base64");
    return { name: basename(f, extname(f)), dataUri: `data:${mime};base64,${b64}` };
  });
}

async function readPlate(
  fixture: { name: string; dataUri: string },
  candidate: Candidate,
  trial: number,
): Promise<ReadResult> {
  const { effort, model, label } = candidate;
  const usage = createPhotoUsageLog();
  const startedAt = Date.now();
  const base = { effort, model, label, trial };
  // Pin the model through the surface knob for this read only (the harness
  // is sequential), so production code decides everything else.
  const previousKnob = process.env[MEAL_PHOTO_KNOB];
  if (model === "default") delete process.env[MEAL_PHOTO_KNOB];
  else process.env[MEAL_PHOTO_KNOB] = model;
  try {
    const analysis = await generateMealPhotoAnalysis({
      image: fixture.dataUri,
      patient: PATIENT,
      slot: SLOT,
      onUsage: usage.recorder("meal"),
      // The harness is the ONE caller allowed to pin an effort: candidates
      // run against the default baseline on the identical code path.
      ...(effort === "default" ? {} : { experimentReasoningEffort: effort }),
      signal: new AbortController().signal,
      log: { warn: (obj, msg) => console.warn(`  [warn] ${msg}`, JSON.stringify(obj)) },
    });
    const spent = usage.snapshot()?.meal;
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      reasoningTokens: spent?.reasoning ?? 0,
      promptTokens: spent?.prompt ?? 0,
      completionTokens: spent?.completion ?? 0,
      modelCalls: spent?.calls ?? 0,
      outcome: analysis.outcome,
      mealName: analysis.payload?.name ?? null,
      totalCalories: analysis.payload?.calories ?? null,
      items: (analysis.payload?.ingredients ?? []).map((ing) => ({
        name: ing.name,
        amount: ing.amount,
        unit: ing.unit,
        calories: ing.nutrition.calories,
      })),
    };
  } catch (error) {
    const spent = usage.snapshot()?.meal;
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      reasoningTokens: spent?.reasoning ?? 0,
      promptTokens: spent?.prompt ?? 0,
      completionTokens: spent?.completion ?? 0,
      modelCalls: spent?.calls ?? 0,
      outcome: "unreadable",
      mealName: null,
      totalCalories: null,
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (previousKnob === undefined) delete process.env[MEAL_PHOTO_KNOB];
    else process.env[MEAL_PHOTO_KNOB] = previousKnob;
  }
}

const normalizeName = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Conservative parity check for one candidate read against the default read
 * of the same plate. Name differences count as differences (the recorded
 * outputs let a human overrule wording-only mismatches — the gate errs
 * toward keeping the default).
 */
function compareToDefault(
  candidate: ReadResult,
  baseline: ReadResult,
): { parity: boolean; notes: string[] } {
  const notes: string[] = [];
  if (candidate.error || baseline.error) {
    notes.push("errored read");
    return { parity: false, notes };
  }
  if (candidate.outcome !== baseline.outcome) {
    notes.push(`outcome ${candidate.outcome} vs ${baseline.outcome}`);
    return { parity: false, notes };
  }
  if (baseline.outcome !== "ok") return { parity: true, notes: ["both non-ok"] };

  const baseItems = new Map(baseline.items.map((i) => [normalizeName(i.name), i]));
  const candItems = new Map(candidate.items.map((i) => [normalizeName(i.name), i]));
  const missing = [...baseItems.keys()].filter((n) => !candItems.has(n));
  const added = [...candItems.keys()].filter((n) => !baseItems.has(n));
  if (missing.length > 0) notes.push(`missing: ${missing.join("; ")}`);
  if (added.length > 0) notes.push(`added: ${added.join("; ")}`);

  let portionsOk = true;
  for (const [name, baseItem] of baseItems) {
    const candItem = candItems.get(name);
    if (!candItem) continue;
    const delta = Math.abs(candItem.calories - baseItem.calories) / Math.max(1, baseItem.calories);
    if (delta > PARITY_ITEM_CAL_TOLERANCE) {
      portionsOk = false;
      notes.push(`${name}: ${candItem.calories} vs ${baseItem.calories} kcal`);
    }
  }
  const baseTotal = baseline.totalCalories ?? 0;
  const candTotal = candidate.totalCalories ?? 0;
  const totalDelta = Math.abs(candTotal - baseTotal) / Math.max(1, baseTotal);
  if (totalDelta > PARITY_TOTAL_CAL_TOLERANCE) {
    portionsOk = false;
    notes.push(`total ${candTotal} vs ${baseTotal} kcal`);
  }
  return { parity: missing.length === 0 && added.length === 0 && portionsOk, notes };
}

function formatRead(r: ReadResult): string {
  const lines: string[] = [];
  const spent = `${(r.latencyMs / 1000).toFixed(1)}s, ${r.reasoningTokens} reasoning tok, ${r.modelCalls} call(s)`;
  if (r.error) {
    lines.push(`- FAILED (${spent}): ${r.error}`);
    return lines.join("\n");
  }
  lines.push(
    `- outcome **${r.outcome}**${r.mealName ? ` — "${r.mealName}"` : ""}${r.totalCalories !== null ? `, ${r.totalCalories} kcal total` : ""} (${spent})`,
  );
  for (const item of r.items) {
    lines.push(`  - ${item.name}: ${item.amount} ${item.unit} — ${item.calories} kcal`);
  }
  return lines.join("\n");
}

async function main() {
  const { candidates, efforts, models, trials, out } = parseArgs();
  const fixtures = loadFixtures();
  console.log(
    `meal-read harness: ${fixtures.length} plates x ${candidates.map((c) => c.label).join("/")} x ${trials} trial(s)`,
  );

  // Sequential on purpose: parallel vision calls would contend for upstream
  // slots and pollute the latency comparison (and trip request bursts).
  const results = new Map<string, ReadResult[]>();
  for (const fixture of fixtures) {
    const reads: ReadResult[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      for (const candidate of candidates) {
        process.stdout.write(`  ${fixture.name} @ ${candidate.label} (trial ${trial})... `);
        const read = await readPlate(fixture, candidate, trial);
        console.log(
          read.error
            ? `FAILED ${read.error}`
            : `${(read.latencyMs / 1000).toFixed(1)}s, ${read.items.length} items, ${read.reasoningTokens} rtok`,
        );
        reads.push(read);
      }
    }
    results.set(fixture.name, reads);
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const report: string[] = [
    `# Meal-read side-by-side — ${today}`,
    "",
    `Production code path (generateMealPhotoAnalysis), ${fixtures.length} fixture plates, ` +
      `efforts: ${efforts.join(", ")} ("default" = knob omitted, the production setting), ` +
      `models: ${models.map((m) => (m === "default" ? `default (${DEFAULT_MODELS["coach.meal_photo"]})` : m)).join(", ")}, ` +
      `${trials} trial(s) per pair. Parity rule: same item name sets AND per-item calories ` +
      `within ±${PARITY_ITEM_CAL_TOLERANCE * 100}% AND total within ±${PARITY_TOTAL_CAL_TOLERANCE * 100}% ` +
      `of the default read, on EVERY plate. A candidate that misses parity anywhere does not ship.`,
    "",
  ];

  const parityByCandidate = new Map<string, { parity: number; different: number }>();
  for (const fixture of fixtures) {
    const reads = results.get(fixture.name) ?? [];
    report.push(`## ${fixture.name}`, "");
    for (const read of reads) {
      report.push(`### ${read.label} (trial ${read.trial})`, formatRead(read), "");
    }
    for (const read of reads) {
      if (read.label === "default") continue;
      const baseline = reads.find((r) => r.label === "default" && r.trial === read.trial);
      if (!baseline) continue;
      const { parity, notes } = compareToDefault(read, baseline);
      const tally = parityByCandidate.get(read.label) ?? { parity: 0, different: 0 };
      parity ? (tally.parity += 1) : (tally.different += 1);
      parityByCandidate.set(read.label, tally);
      report.push(
        `**${read.label} vs default (trial ${read.trial}):** ${parity ? "PARITY" : "DIFFERENT"}` +
          (notes.length > 0 ? ` — ${notes.join("; ")}` : ""),
        "",
      );
    }
  }

  report.push("## Verdict", "");
  for (const [label, tally] of parityByCandidate) {
    const total = tally.parity + tally.different;
    report.push(
      `- **${label}**: parity on ${tally.parity}/${total} plate-trials — ` +
        (tally.different === 0
          ? "matches the default read across the whole set."
          : "NOT parity; per the gate rule this setting must not ship for the plate read."),
    );
  }
  report.push("");

  const outPath = join(HERE, out ?? `results/${today}.md`);
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, report.join("\n"));
  console.log(`\nreport written to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
