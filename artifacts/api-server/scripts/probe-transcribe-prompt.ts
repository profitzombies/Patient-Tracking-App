/**
 * One-off acceptance probe: does the AI gateway pass the transcription
 * `prompt` (spelling-bias hint) through to gpt-4o-mini-transcribe, or reject
 * it? Acceptance evidence only — the deterministic normalizer remains the
 * guarantee. Run: pnpm --filter @workspace/api-server exec tsx scripts/probe-transcribe-prompt.ts
 */
import { createReadStream } from "fs";
import { openai } from "@workspace/integrations-openai-ai-server";

const FILE = "/tmp/probe-tone.wav";

async function main(): Promise<void> {
  const base = await openai.audio.transcriptions.create({
    file: createReadStream(FILE),
    model: "gpt-4o-mini-transcribe",
    response_format: "json",
  });
  console.log("baseline accepted:", JSON.stringify(base).slice(0, 200));

  const prompted = await openai.audio.transcriptions.create({
    file: createReadStream(FILE),
    model: "gpt-4o-mini-transcribe",
    response_format: "json",
    prompt:
      "Internal staff training video for the THINNR med-spa weight-loss program. " +
      "THINNR, THINNR Boost, and the THINNR Metabolic Thinning Phase are brand names.",
  });
  console.log("prompted accepted:", JSON.stringify(prompted).slice(0, 200));
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exit(1);
});
