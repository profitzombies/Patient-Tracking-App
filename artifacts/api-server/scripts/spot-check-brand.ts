/**
 * Real-model spot checks for the THINNR brand-spelling guard (one-off,
 * rerunnable). Two surfaces whose grounding material deliberately contains
 * the misspelling:
 *
 * 1. Coach chat over HTTP+SSE (the full marker→brand→dash stream chain),
 *    asked questions grounded in docs that say "THINNER program" and
 *    "Thinner Metabolic Thinning Phase".
 * 2. Training description + chapters generation run against transcript text
 *    that spells the brand "Thinner"/"thinner".
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/spot-check-brand.ts
 * (API server must be running for the coach check.)
 */
import { writeChapters, writeDescription } from "../src/training/pipeline";

const API_BASE = (process.env.STAFF_API_BASE ?? "http://localhost:80").replace(/\/$/, "");
const MISSPELLING = /THINNER|Thinner\b/;

let failures = 0;

function check(label: string, text: string): void {
  const bad = text.match(MISSPELLING);
  if (bad) {
    failures += 1;
    console.error(`✗ ${label}: contains "${bad[0]}"`);
  } else {
    console.log(`✓ ${label}: no misspelling${text.includes("THINNR") ? " (mentions THINNR)" : ""}`);
  }
}

async function coachTurn(question: string): Promise<string> {
  const response = await fetch(`${API_BASE}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
  });
  if (!response.ok) throw new Error(`coach chat ${response.status}: ${await response.text()}`);
  const raw = await response.text();
  return [...raw.matchAll(/^data: (\{.*\})$/gm)]
    .map((match) => JSON.parse(match[1]) as { content?: string })
    .map((event) => event.content ?? "")
    .join("");
}

async function main(): Promise<void> {
  // --- Coach chat (grounded in docs that misspell the brand) ---
  const questions = [
    "Is exercise required on the THINNR program?",
    "Why do all patients get the same amount of food during the metabolic thinning phase?",
  ];
  for (const question of questions) {
    const reply = await coachTurn(question);
    if (!reply.trim()) throw new Error(`coach reply came back empty for: ${question}`);
    console.log(`\ncoach> ${question}\n${reply}\n`);
    check(`coach reply (${question.slice(0, 40)}…)`, reply);
  }

  // --- Training description + chapters from a misspelled transcript ---
  const segments = [
    {
      at: 0,
      end: 60,
      text: "Welcome to the Thinner program. In this video we walk through how the thinner protocol starts for a new patient.",
    },
    {
      at: 60,
      end: 120,
      text: "During the Thinner Metabolic Thinning Phase, patients follow the fixed menu. Blood thinner medications should be flagged to the provider.",
    },
  ];
  const paragraphs = await writeDescription("Welcome to the program", segments);
  console.log(`\ndescription>\n${paragraphs.join("\n\n")}\n`);
  check("training description", paragraphs.join("\n\n"));

  const chapters = await writeChapters("Welcome to the program", segments, 120);
  const titles = chapters.map((c) => `${c.at}s ${c.title}`).join(" | ");
  console.log(`\nchapters> ${titles}\n`);
  check("training chapter titles", titles);

  if (failures > 0) {
    console.error(`\n${failures} spot check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll brand spot checks passed.");
}

main().catch((error) => {
  console.error("spot check failed:", error);
  process.exit(1);
});
