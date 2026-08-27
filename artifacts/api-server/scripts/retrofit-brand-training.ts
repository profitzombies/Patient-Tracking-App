/**
 * One-off retrofit (rerunnable, idempotent): apply the shared THINNR
 * brand-spelling guard to training AI outputs persisted BEFORE the guard
 * existed. Applies exactly the transformations the pipeline now performs at
 * persist time — `normalizeBrandSpelling` on description paragraphs and
 * chapter titles, plus the transcript-only `normalizeSpokenBrandMentions`
 * on segment text — so retrofitted rows match what a post-guard run would
 * have stored. Rows already clean are left untouched.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/retrofit-brand-training.ts
 */
import {
  normalizeBrandSpelling,
  normalizeSpokenBrandMentions,
} from "../src/lib/brand-spelling";

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

async function rest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base()}/rest/v1${path}`, {
    method,
    headers: headers(method === "GET" ? undefined : { Prefer: "return=minimal" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed (${response.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const fixProse = (text: string): string => normalizeBrandSpelling(text);
const fixTranscript = (text: string): string =>
  normalizeSpokenBrandMentions(normalizeBrandSpelling(text));

async function main(): Promise<void> {
  let patched = 0;

  const videos = (await rest(
    "GET",
    "/training_videos?select=id,title,description,chapters",
  )) as Array<{ id: string; title: string; description: unknown; chapters: unknown }>;
  for (const video of videos) {
    const patch: Record<string, unknown> = {};
    if (Array.isArray(video.description)) {
      const next = video.description.map((p) => (typeof p === "string" ? fixProse(p) : p));
      if (JSON.stringify(next) !== JSON.stringify(video.description)) patch.description = next;
    }
    if (Array.isArray(video.chapters)) {
      const next = video.chapters.map((c) =>
        c && typeof c === "object" && typeof (c as { title?: unknown }).title === "string"
          ? { ...(c as object), title: fixProse((c as { title: string }).title) }
          : c,
      );
      if (JSON.stringify(next) !== JSON.stringify(video.chapters)) patch.chapters = next;
    }
    if (Object.keys(patch).length > 0) {
      await rest("PATCH", `/training_videos?id=eq.${video.id}`, patch);
      patched += 1;
      console.log(`patched video "${video.title}": ${Object.keys(patch).join(", ")}`);
    }
  }

  const transcripts = (await rest(
    "GET",
    "/training_video_transcripts?select=video_id,segments",
  )) as Array<{ video_id: string; segments: unknown }>;
  for (const row of transcripts) {
    if (!Array.isArray(row.segments)) continue;
    const next = row.segments.map((seg) =>
      seg && typeof seg === "object" && typeof (seg as { text?: unknown }).text === "string"
        ? { ...(seg as object), text: fixTranscript((seg as { text: string }).text) }
        : seg,
    );
    if (JSON.stringify(next) !== JSON.stringify(row.segments)) {
      await rest("PATCH", `/training_video_transcripts?video_id=eq.${row.video_id}`, {
        segments: next,
      });
      patched += 1;
      console.log(`patched transcript for video ${row.video_id}`);
    }
  }

  console.log(patched === 0 ? "nothing to retrofit — all rows clean" : `retrofitted ${patched} row(s)`);
}

main().catch((error) => {
  console.error("retrofit failed:", error);
  process.exit(1);
});
