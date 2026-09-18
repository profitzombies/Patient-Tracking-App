/**
 * Coach chat model-tier harness — the gate for switching the chat model.
 *
 * Runs the production chat prompt (selectCompartments + buildSystemPrompt +
 * buildChatMessages, the same bytes the /coach/chat route sends) over a
 * fixed question set at each requested model, and writes a markdown report
 * comparing every candidate against the shipped default on the contracts
 * the coach suites and memory enforce:
 *
 *   - grounding: quoted program wording and every number-with-unit in the
 *     reply must appear verbatim in the sources the model was given; out
 *     of scope questions must send the patient to the care team;
 *   - reply shape: 2-4 blank-line-separated blocks, a closer;
 *   - voice: no dashes, no markdown, no emoji, no stock openers, THINNR
 *     spelled as the brand;
 *   - one-tap marker emission when the reply ends with a question;
 *   - latency, tokens, and estimated cost per reply.
 *
 * The checks are conservative aids, not a judge: every reply is recorded in
 * full so a human can read borderline cases. The rule this harness serves:
 *
 *   A cheaper tier ships for chat only when it matches the default on every
 *   grounding check and stays within a few points on shape, voice, and
 *   marker rate, across the WHOLE question set, in a recorded run kept in
 *   docs/ai-model-tiers.md. A single good answer is never evidence.
 *
 * Usage (live model calls — costs real tokens):
 *   pnpm --filter @workspace/api-server run harness:coach-chat -- \
 *     --models default,gpt-5.4-mini --trials 2 --out results/2026-09-18.md
 *
 * "default" is the production model for coach.chat (see src/ai/models.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "@workspace/integrations-openai-ai-server";
import { DEFAULT_MODELS } from "../../src/ai/models";
import { estimateCostMicros, loadPricingTable } from "../../src/ai-usage/pricing";
import { demoPatientContext } from "../../src/coach/demo-patient";
import { buildChatMessages, buildSystemPrompt } from "../../src/coach/prompt";
import { selectCompartments } from "../../src/coach/select";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Question {
  id: string;
  text: string;
  /** The materials do not answer this; the coach must refer to the care team, not guess. */
  expectReferral?: boolean;
}

/**
 * Fixed set: the everyday questions patients actually ask (foods, phase
 * amounts, dosing, stalls, dining out), plus two the materials do not
 * cover, where guessing is the failure mode that matters most.
 */
const QUESTIONS: Question[] = [
  { id: "coffee", text: "Can I have coffee in the morning?" },
  { id: "dinner-protein", text: "How much protein should I eat at dinner tonight?" },
  { id: "bacon", text: "Is bacon approved?" },
  { id: "vegetables", text: "What vegetables are approved?" },
  { id: "missed-dose", text: "I forgot to take my drops this morning, what do I do?" },
  { id: "stall", text: "The scale hasn't moved in four days. Is something wrong?" },
  { id: "restaurant", text: "I'm going out for Mexican food tonight, what should I order?" },
  { id: "sweetener", text: "Why can't I use regular sugar? Is stevia okay?" },
  { id: "ibuprofen", text: "Can I take ibuprofen for a headache while on the drops?", expectReferral: true },
  { id: "keto", text: "Can I combine this with a keto diet and a 20 hour fast?", expectReferral: true },
];

interface Checks {
  quotesInSources: boolean;
  numbersInSources: boolean;
  referral: boolean | null;
  blocks: number;
  shapeOk: boolean;
  closer: boolean;
  marker: boolean;
  noDashes: boolean;
  noMarkdown: boolean;
  noEmoji: boolean;
  noStockOpener: boolean;
  brandSpelling: boolean;
}

interface Reply {
  model: string;
  question: Question;
  trial: number;
  text: string;
  latencyMs: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  checks: Checks;
  error?: string;
}

function parseArgs(): { models: string[]; trials: number; out: string | undefined } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const models = (get("--models") ?? "default,gpt-5.4-mini").split(",").map((m) => m.trim()).filter(Boolean);
  if (!models.includes("default")) {
    throw new Error('the models list must include "default" — it is the comparison baseline');
  }
  return { models, trials: Number(get("--trials") ?? "1"), out: get("--out") };
}

const normalize = (text: string) =>
  text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();

function check(reply: string, sources: string, question: Question): Checks {
  const body = reply.replace(/\n?\[\[replies:[a-z_]+\]\]\s*$/, "").trim();
  const haystack = normalize(sources);
  // Quoted spans of three or more words must be program wording. Sentence
  // punctuation the coach tucks inside the closing quote (American style)
  // is not part of the quoted rule, so it is trimmed before matching.
  const quotes = [...body.matchAll(/[\u201c"]([^\u201c\u201d"]{12,}?)[\u201d"]/g)].map((m) =>
    m[1].trim().replace(/^[(\s]+/, "").replace(/[.,;:!?)\s]+$/, ""),
  );
  const quotesInSources = quotes.every((q) => q.split(/\s+/).length < 3 || haystack.includes(normalize(q)));
  // Every amount the coach states must exist in the sources it was given.
  const amounts = [...body.matchAll(/\b(\d+(?:[.,]\d+)?(?:\s?-\s?\d+(?:[.,]\d+)?)?)\s?(oz|ounces?|cups?|tbsp|tsp|grams?|g|lbs?|pounds?|calories?|cal|drops?|minutes?|hours?|days?|weeks?)\b/gi)];
  const numbersInSources = amounts.every((m) => {
    const numbers = m[1].split(/\s?-\s?/).map((n) => n.replace(",", "."));
    return numbers.every((n) => haystack.includes(n));
  });
  const referral = question.expectReferral ? /care team|provider|doctor|physician/i.test(body) : null;
  const blocks = body.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const last = blocks[blocks.length - 1] ?? "";
  return {
    quotesInSources,
    numbersInSources,
    referral,
    blocks: blocks.length,
    shapeOk: blocks.length >= 2 && blocks.length <= 4,
    closer: /\?\s*$/.test(last.trim()) || blocks.length >= 2,
    marker: /\[\[replies:[a-z_]+\]\]/.test(reply),
    noDashes: !/[\u2013\u2014]/.test(body) && !/(^|\s)-{1,2}(\s|$)/.test(body),
    noMarkdown: !/(^|\n)\s*([#*-]\s|\d+\.\s)|\*\*|`/.test(body),
    noEmoji: !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(body),
    noStockOpener: !/^(great|good) question|^thanks for asking|^that'?s a (great|good) question/i.test(body),
    brandSpelling: !/\bTHINNER\b|\bThinner\b/.test(body),
  };
}

async function ask(model: string, resolvedModel: string, question: Question, trial: number): Promise<Reply> {
  const selection = selectCompartments(question.text, []);
  const patient = demoPatientContext();
  const systemPrompt = buildSystemPrompt(selection.compartments, patient);
  const messages = buildChatMessages(systemPrompt, null, [{ role: "user", content: question.text }]);
  const sources = selection.compartments.map((c) => c.load()).join("\n\n");
  const table = loadPricingTable();
  const startedAt = Date.now();
  try {
    const completion = await openai.chat.completions.create({
      model: resolvedModel,
      max_completion_tokens: 8192,
      messages,
    });
    const text = completion.choices[0]?.message?.content ?? "";
    const usage = completion.usage;
    const tokens = {
      promptTokens: usage?.prompt_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
    const micros = estimateCostMicros(resolvedModel, tokens, table);
    return {
      model,
      question,
      trial,
      text,
      latencyMs: Date.now() - startedAt,
      ...tokens,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      costUsd: micros === null ? null : micros / 1_000_000,
      checks: check(text, sources, question),
      ...(text.trim().length === 0 ? { error: "empty reply" } : {}),
    };
  } catch (error) {
    return {
      model,
      question,
      trial,
      text: "",
      latencyMs: Date.now() - startedAt,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      checks: check("", sources, question),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const percent = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))] ?? 0;
};

function summarize(model: string, replies: Reply[]): string {
  const ok = replies.filter((r) => !r.error);
  const rate = (pick: (c: Checks) => boolean | null) => {
    const applicable = ok.filter((r) => pick(r.checks) !== null);
    return percent(applicable.filter((r) => pick(r.checks) === true).length, applicable.length);
  };
  const latencies = ok.map((r) => r.latencyMs);
  const mean = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const cost = ok.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const words = ok.length ? Math.round(ok.reduce((sum, r) => sum + r.text.split(/\s+/).length, 0) / ok.length) : 0;
  return [
    `| ${model} | ${ok.length}/${replies.length} | ${rate((c) => c.quotesInSources && c.numbersInSources)} | ${rate((c) => c.referral)} | ${rate((c) => c.shapeOk)} | ${rate((c) => c.marker)} | ${rate((c) => c.noDashes && c.noMarkdown && c.noEmoji && c.noStockOpener && c.brandSpelling)} | ${words} | ${(mean / 1000).toFixed(1)}s / ${(p95(latencies) / 1000).toFixed(1)}s | ${ok.length ? Math.round(ok.reduce((s, r) => s + r.reasoningTokens, 0) / ok.length) : 0} | $${(cost / Math.max(1, ok.length)).toFixed(4)} |`,
  ].join("");
}

function failures(checks: Checks): string[] {
  const out: string[] = [];
  if (!checks.quotesInSources) out.push("quote not in sources");
  if (!checks.numbersInSources) out.push("amount not in sources");
  if (checks.referral === false) out.push("no care-team referral");
  if (!checks.shapeOk) out.push(`${checks.blocks} block(s)`);
  if (!checks.noDashes) out.push("dash");
  if (!checks.noMarkdown) out.push("markdown");
  if (!checks.noEmoji) out.push("emoji");
  if (!checks.noStockOpener) out.push("stock opener");
  if (!checks.brandSpelling) out.push("brand spelling");
  return out;
}

async function main(): Promise<void> {
  const { models, trials, out } = parseArgs();
  const resolved = (model: string) => (model === "default" ? DEFAULT_MODELS["coach.chat"] : model);
  const replies: Reply[] = [];
  for (const model of models) {
    for (const question of QUESTIONS) {
      for (let trial = 1; trial <= trials; trial++) {
        const reply = await ask(model, resolved(model), question, trial);
        replies.push(reply);
        const flags = reply.error ? [`ERROR ${reply.error}`] : failures(reply.checks);
        console.log(`${model} ${question.id} #${trial}: ${(reply.latencyMs / 1000).toFixed(1)}s ${flags.length ? flags.join(", ") : "ok"}`);
      }
    }
  }

  const lines: string[] = [];
  const day = new Date().toISOString().slice(0, 10);
  lines.push(`# Coach chat model tiers — ${day}`, "");
  lines.push(
    `Production chat prompt (selectCompartments + buildSystemPrompt + buildChatMessages), ${QUESTIONS.length} questions, ${trials} trial(s) per model, demo patient context. Models: ${models.map((m) => `${m} (${resolved(m)})`).join(", ")}. Grounding = every quoted span and every number-with-unit in the reply appears verbatim in the sources given; referral = out-of-scope questions point to the care team; shape = 2-4 blocks; marker = one-tap reply marker present; voice = no dashes, markdown, emoji, stock openers, brand misspelling.`,
    "",
  );
  lines.push("| model | replies | grounding | referral | shape | marker | voice | words | latency mean / p95 | reasoning tok | cost per reply |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const model of models) lines.push(summarize(model, replies.filter((r) => r.model === model)));
  lines.push("");
  for (const question of QUESTIONS) {
    lines.push(`## ${question.id} — ${question.text}`, "");
    for (const reply of replies.filter((r) => r.question.id === question.id)) {
      const flags = reply.error ? [`ERROR ${reply.error}`] : failures(reply.checks);
      lines.push(`### ${reply.model} (trial ${reply.trial}) — ${(reply.latencyMs / 1000).toFixed(1)}s, ${reply.promptTokens} prompt (${reply.cachedTokens} cached), ${reply.completionTokens} completion (${reply.reasoningTokens} reasoning), ${reply.costUsd === null ? "unpriced" : `$${reply.costUsd.toFixed(4)}`}${flags.length ? ` — **${flags.join(", ")}**` : ""}`, "");
      lines.push(...reply.text.split("\n").map((l) => `> ${l}`), "");
    }
  }
  const report = lines.join("\n");
  const target = out ?? join(HERE, "results", `${day}.md`);
  mkdirSync(dirname(join(HERE, target)), { recursive: true });
  writeFileSync(target.startsWith("/") ? target : join(HERE, target), report);
  console.log(`\nreport: ${target}`);
  console.log(lines.slice(4, 5 + 2 + models.length).join("\n"));
}

void main();
