/**
 * AI Support chat for provider offices — POST /api/support/chat (SSE).
 *
 * The office-facing sibling of the patient coach route, and the replacement
 * for the operator's old Zapier support assistant. Same wire contract and
 * reliability guards (keepalive comments, idle deadline per model call,
 * abort lifecycle, no silent truncation), but a very different persona:
 * answers come ONLY from the HQ-uploaded knowledge documents, in an
 * extremely comprehensive markdown + emoji style.
 *
 * Grounding is two-staged, mirroring the coach's compartment router:
 * stage 1 attaches the best-matching documents; if the model signals (via a
 * stripped control marker) that those cannot answer, the SAME response
 * stream re-runs the turn with the whole library before the assistant may
 * say it doesn't know. The client just sees a longer first-token wait —
 * narrated by stage events ({stage: searching|thinking|formulating}) that
 * ride the stream as the server actually moves through document search,
 * model start, and first visible output, so the UI's status line reflects
 * real work, never a timer. Unknown-field events are ignored by older
 * clients, so the addition is wire-compatible.
 *
 * Demo posture: reaching the page is enough — there is NO staff-session
 * gate. The staff identity was only ever a gate here (answers come from one
 * global library read with the service role; no office scoping, no
 * attribution), so demo personas chat exactly like signed-in staff, whose
 * bearer, when attached, is simply ignored. Spend stays bounded by the
 * endpoint's OWN limiter knobs — per-IP burst, concurrency, and daily
 * budget — plus the app-level CORS allowlist. Re-tightening later is one
 * middleware away.
 *
 * Voice: comprehensive markdown, strictly emoji-free — the prompt bans
 * emojis and the EmojiSmoother strips any that slip through, chunk-split
 * ones included, flushing on every stream end (error paths too).
 */
import { Router, type IRouter } from "express";
import type { Response } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { SupportChatBody } from "@workspace/api-zod";
import { DashSmoother } from "../coach/text-style";
import { MarkerFilter } from "../coach/markers";
import {
  UpstreamTimeoutError,
  createUpstreamDeadline,
  keepaliveIntervalMs,
} from "../coach/upstream";
import { loadSupportDocuments, type SupportDocument } from "../support/docs";
import { selectSupportDocuments } from "../support/select";
import {
  EMPTY_LIBRARY_MESSAGE,
  buildSupportSystemPrompt,
  toSupportModelMessages,
  type SupportPromptMode,
} from "../support/prompt";
import { acquireSupportSlot } from "../support/limits";
import { BrandSpellingSmoother, EmojiSmoother } from "../support/text-guards";

const router: IRouter = Router();

/**
 * Progress narration for the client's thinking indicator, emitted at the
 * moment the work actually happens: `searching` when the stream opens on a
 * freshly selected document set (again on a stage-2 broaden, which re-grounds
 * against the full library), `thinking` when a model call starts, and
 * `formulating` just before the first visible character of the reply.
 */
type SupportStage = "searching" | "thinking" | "formulating";

function writeStage(res: Response, stage: SupportStage): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ stage })}\n\n`);
  }
}

/** Most recent messages kept per request; the client sends session history. */
const MAX_HISTORY = 12;

const SUPPORT_ERROR_MESSAGE = "AI Support is unavailable right now. Please try again.";
const LIBRARY_ERROR_MESSAGE =
  "AI Support cannot reach the knowledge library right now. Please try again.";

/**
 * One grounded model call streamed onto the open SSE response. Returns what
 * the route needs to decide on broadening: whether the model asked for the
 * full library, and whether any visible text reached the wire.
 */
async function streamSupportTurn(options: {
  res: Response;
  abortSignal: AbortSignal;
  documents: SupportDocument[];
  mode: SupportPromptMode;
  modelHistory: { role: "user" | "assistant"; content: string }[];
}): Promise<{ broadenRequested: boolean; wroteVisible: boolean }> {
  const { res, abortSignal, documents, mode, modelHistory } = options;

  // The broaden marker is a control signal, never visible text. The filter
  // runs in BOTH modes so a stray marker from a confused full-mode reply is
  // still stripped from the wire.
  const markerFilter = new MarkerFilter(["broaden"]);
  const brandSmoother = new BrandSpellingSmoother();
  const dashSmoother = new DashSmoother();
  // Last in the chain so nothing downstream can reintroduce an emoji; its
  // flush rides drainHeld, which runs on error paths too.
  const emojiSmoother = new EmojiSmoother();

  let visible = "";
  const write = (text: string) => {
    if (!text) return;
    // First visible character of this turn: the model is done reasoning and
    // its answer is about to land.
    if (visible.length === 0) writeStage(res, "formulating");
    visible += text;
    res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
  };
  const drainHeld = () =>
    emojiSmoother.push(
      dashSmoother.push(brandSmoother.push(markerFilter.flush()) + brandSmoother.flush()) +
        dashSmoother.flush(),
    ) + emojiSmoother.flush();

  // Idle deadline, restarted on every chunk: bounds SILENCE (reasoning
  // preamble or a wedged upstream), not total reply length.
  const deadline = createUpstreamDeadline(abortSignal);
  try {
    // The request is on its way to the model: narrate before the call so the
    // whole silent reasoning stretch sits under "thinking", not "searching".
    writeStage(res, "thinking");
    const stream = await openai.chat.completions.create(
      {
        model: "gpt-5.6-terra",
        // Reasoning models spend part of this budget internally, and the
        // persona's contract is "do not shorten": comprehensive markdown
        // answers get more headroom than the texting-style coach.
        max_completion_tokens: 16384,
        stream: true,
        messages: [
          { role: "system", content: buildSupportSystemPrompt(documents, mode) },
          ...modelHistory,
        ],
      },
      { signal: deadline.signal },
    );

    for await (const chunk of stream) {
      deadline.touch();
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        write(emojiSmoother.push(dashSmoother.push(brandSmoother.push(markerFilter.push(delta)))));
      }
    }
  } catch (error) {
    // The stream died mid-reply: drain what the filters were holding back so
    // every character cleared for display reaches the wire before the error
    // event. (No-drop wire contract, same as the coach.)
    if (!abortSignal.aborted) {
      write(drainHeld());
    }
    throw deadline.expired
      ? new UpstreamTimeoutError("support chat completion", deadline.idleMs, { cause: error })
      : error;
  } finally {
    deadline.finish();
  }
  write(drainHeld());

  return {
    broadenRequested: markerFilter.idsFor("broaden").length > 0,
    wroteVisible: visible.trim().length > 0,
  };
}

router.post("/support/chat", async (req, res) => {
  const startedAt = Date.now();
  // Limit first: this endpoint spends paid model credits, so even invalid
  // spam should burn the caller's budget, not the server's CPU.
  const slot = acquireSupportSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }

  try {
    const parsed = SupportChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const history = parsed.data.messages.slice(-MAX_HISTORY);
    const latest = history[history.length - 1];
    if (!latest || latest.role !== "user") {
      res.status(400).json({ error: "Last message must be from the user" });
      return;
    }

    // Load the library BEFORE the stream opens, so an unreachable database
    // answers as a plain retryable JSON error instead of a broken stream.
    let documents: SupportDocument[];
    try {
      documents = await loadSupportDocuments();
    } catch (error) {
      req.log.error({ err: error }, "support chat knowledge library unavailable");
      res.status(503).json({ error: LIBRARY_ERROR_MESSAGE, retryable: true });
      return;
    }

    const earlierUserMessages = history
      .slice(0, -1)
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    const selection = selectSupportDocuments(documents, latest.content, earlierUserMessages);
    req.log.info(
      {
        documents: documents.length,
        stage1: selection.primaryIds,
        stage1IsFullLibrary: selection.broadened,
      },
      "support chat documents selected",
    );

    // Replies the provider stopped mid-stream arrive flagged; annotate them
    // once so the model never continues cut-off text.
    const modelHistory = toSupportModelMessages(history);

    // Which grounding stage produced the reply — failure/completion logs
    // carry it so a mystery error can be traced to its stage and duration.
    let stage: "primary" | "full" = selection.broadened ? "full" : "primary";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // The turn opens on freshly selected documents (selection ran just
    // above); narrate it so the client's status line starts truthfully.
    writeStage(res, "searching");

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    // Keepalive from stream start until the turn ends: SSE comment lines are
    // invisible to consumers but keep bytes flowing, so idle-connection
    // proxies never drop the stream — a broadened turn re-runs the model on
    // the same response and can stay token-silent for a long stretch.
    const keepalive = setInterval(() => {
      if (!abort.signal.aborted && !res.writableEnded) {
        res.write(": keepalive\n\n");
      }
    }, keepaliveIntervalMs());

    try {
      // An empty library cannot answer anything: honesty without burning a
      // model call. (Unreachable in the demo, which seeds five documents.)
      if (documents.length === 0) {
        stage = "full";
        res.write(`data: ${JSON.stringify({ content: EMPTY_LIBRARY_MESSAGE })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        req.log.info(
          { stage, elapsedMs: Date.now() - startedAt, emptyLibrary: true },
          "support chat turn completed",
        );
        return;
      }

      // Stage 1: best-match documents (or the whole library when scoring
      // found nothing to trust).
      const first = await streamSupportTurn({
        res,
        abortSignal: abort.signal,
        documents: selection.primary,
        mode: stage,
        modelHistory,
      });

      let wroteVisible = first.wroteVisible;
      if (
        first.broadenRequested &&
        !first.wroteVisible &&
        selection.remaining.length > 0 &&
        !abort.signal.aborted
      ) {
        // Stage 2: the model said the best matches cannot answer. Re-run the
        // turn with the COMPLETE library on the same stream; only after this
        // may the assistant say it doesn't know.
        stage = "full";
        req.log.info(
          { stage1: selection.primaryIds, documents: documents.length },
          "support chat broadened to full library",
        );
        // Stage 2 re-grounds against the complete library — that IS another
        // document search, so the narration honestly starts over.
        writeStage(res, "searching");
        const second = await streamSupportTurn({
          res,
          abortSignal: abort.signal,
          documents,
          mode: "full",
          modelHistory,
        });
        wroteVisible = second.wroteVisible;
      }

      if (!abort.signal.aborted) {
        if (!wroteVisible) {
          // Every stage ended without one visible character (for example a
          // full-mode reply that was ONLY a stray marker). A blank bubble is
          // a silent failure; surface it as a retryable error instead.
          req.log.error(
            { stage, elapsedMs: Date.now() - startedAt },
            "support chat produced no visible reply",
          );
          res.write(`data: ${JSON.stringify({ error: SUPPORT_ERROR_MESSAGE })}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        req.log.info(
          { stage, elapsedMs: Date.now() - startedAt },
          "support chat turn completed",
        );
      }
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (abort.signal.aborted) {
        // The client went away mid-turn (stop button, tab closed, proxy cut).
        // Nothing can be written, but keep dropped streams observable.
        req.log.info({ stage, elapsedMs }, "support chat turn aborted by client");
      } else {
        req.log.error({ err: error, stage, elapsedMs }, "support chat stream failed");
        res.write(`data: ${JSON.stringify({ error: SUPPORT_ERROR_MESSAGE })}\n\n`);
      }
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  } finally {
    slot.release();
  }
});

export default router;
