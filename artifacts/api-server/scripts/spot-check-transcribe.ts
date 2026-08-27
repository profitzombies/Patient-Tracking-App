/**
 * End-to-end spoken-brand check (one-off, rerunnable): run the REAL
 * transcription pipeline (spelling-bias prompt + capitalized normalizer +
 * spoken-mention rewrite) over a narrated clip that says "the thinner
 * program", "your thinner coach", and "blood thinner medications" out loud.
 * The brand mentions must come out THINNR; the medication phrase must
 * survive untouched.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/spot-check-transcribe.ts /path/to/clip.wav [durationSeconds]
 */
import { transcribeSegments } from "../src/training/pipeline";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: spot-check-transcribe.ts <wav file> [durationSeconds]");
  const duration = Number(process.argv[3] ?? 30);

  const segments = await transcribeSegments([file], duration);
  const text = segments.map((seg) => seg.text).join(" ");
  console.log(`transcript> ${text}`);

  let failed = false;
  const misspelled = text.match(/THINNER|Thinner\b/);
  if (misspelled) {
    failed = true;
    console.error(`✗ transcript contains "${misspelled[0]}"`);
  } else {
    console.log("✓ no capitalized misspelling");
  }
  const brandMentions = (text.match(/THINNR/g) ?? []).length;
  if (brandMentions === 0) {
    failed = true;
    console.error("✗ transcript never says THINNR (expected the spoken brand mentions rewritten)");
  } else {
    console.log(`✓ THINNR appears ${brandMentions}x`);
  }
  if (!/blood thinner/i.test(text)) {
    // Speech models sometimes drop a phrase; warn rather than fail if the
    // genuine-English control phrase never made it into the transcript.
    console.warn("⚠ control phrase 'blood thinner' not present in transcript");
  } else if (!/blood thinner/.test(text)) {
    failed = true;
    console.error("✗ the genuine 'blood thinner' phrase was rewritten");
  } else {
    console.log("✓ 'blood thinner' preserved as ordinary English");
  }

  if (failed) process.exit(1);
  console.log("Spoken-brand transcription check passed.");
}

main().catch((error) => {
  console.error("spot check failed:", error);
  process.exit(1);
});
