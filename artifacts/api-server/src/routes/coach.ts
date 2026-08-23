import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CoachChatBody } from "@workspace/api-zod";
import { selectCompartments } from "../coach/select";
import { buildSystemPrompt, toModelMessages } from "../coach/prompt";
import { demoPatientContext } from "../coach/demo-patient";
import { acquireChatSlot } from "../coach/limits";
import { findProduct, matchProducts, productCardPayload } from "../coach/products";
import { detectRecipeIntent } from "../coach/intent";
import { generateRecipeTurn } from "../coach/recipe";
import { MarkerFilter } from "../coach/markers";
import { firstQuickReplySet } from "../coach/quick-replies";

const router: IRouter = Router();

/** Most recent messages kept per request; the client sends session history. */
const MAX_HISTORY = 12;

router.post("/coach/chat", async (req, res) => {
  // Limit first: this endpoint spends paid model credits, so even invalid
  // spam should burn the caller's budget, not the server's CPU.
  const slot = acquireChatSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }

  try {
    const parsed = CoachChatBody.safeParse(req.body);
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

    const earlierUserMessages = history
      .slice(0, -1)
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    const selection = selectCompartments(latest.content, earlierUserMessages);
    // Products are offered to the model only when the LATEST message matches
    // their intent topics; ordinary program questions get no product
    // instructions at all.
    const offeredProducts = matchProducts(latest.content);
    req.log.info(
      { compartments: selection.ids, offeredProducts: offeredProducts.map((p) => p.id) },
      "coach chat compartments selected",
    );

    // Patient context is derived server-side from the fixed demo seed; the
    // client is never trusted for it.
    const patientContext = demoPatientContext();

    // Replies the patient stopped mid-stream arrive flagged; annotate them
    // once here so BOTH model pipelines (plain streaming and recipe turns)
    // see the interruption note instead of a seemingly complete answer.
    const modelHistory = toModelMessages(history);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
      // Meal-idea and craving turns switch to the structured JSON pipeline:
      // one non-streaming call that yields a short reply plus a validated
      // recipe card (cravings: approved-foods-only, enforced server-side).
      // Recipe turns use their own prompt, so no product block applies there.
      const intent = detectRecipeIntent(latest.content);
      if (intent) {
        req.log.info({ intent }, "coach recipe turn");
        const result = await generateRecipeTurn({
          mode: intent,
          history: modelHistory,
          compartments: selection.compartments,
          patient: patientContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: result.reply })}\n\n`);
          if (result.card) {
            res.write(`data: ${JSON.stringify({ card: result.card })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        }
        return;
      }

      const stream = await openai.chat.completions.create(
        {
          model: "gpt-5.6-terra",
          // Reasoning models spend part of this budget on internal reasoning
          // tokens; the AI integration requires >= 8192 to avoid empty replies.
          max_completion_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "system",
              content: buildSystemPrompt(selection.compartments, patientContext, offeredProducts),
            },
            ...modelHistory,
          ],
        },
        { signal: abort.signal },
      );

      // Control markers (product recommendation, one-tap answer set) are
      // signals, never visible text: the filter strips them from the stream
      // (even split across chunks) and records the ids for validation below.
      const markerFilter = new MarkerFilter(["product", "replies"]);
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          const visible = markerFilter.push(delta);
          if (visible) {
            res.write(`data: ${JSON.stringify({ content: visible })}\n\n`);
          }
        }
      }
      const tail = markerFilter.flush();
      if (tail) {
        res.write(`data: ${JSON.stringify({ content: tail })}\n\n`);
      }

      // Server-side enforcement: a card is sent only for the first marker id
      // that was actually offered for this message (unknown or unsolicited
      // ids are dropped), and never more than one. The payload is built from
      // the catalog, not from model output.
      const offeredIds = new Set(offeredProducts.map((p) => p.id));
      const chosenId = markerFilter.idsFor("product").find((id) => offeredIds.has(id));
      const chosen = chosenId ? findProduct(chosenId) : undefined;
      if (chosen) {
        res.write(
          `data: ${JSON.stringify({ card: { kind: "product", payload: productCardPayload(chosen) } })}\n\n`,
        );
        req.log.info({ product: chosen.id }, "coach chat product card attached");
      }

      // One-tap answer suggestion: the marker id only selects which curated
      // label pair to send — unknown ids die here, and the labels come from
      // the server allow-list, never from model text. When nothing is sent
      // the client falls back to its static yes/no pair.
      const replySet = firstQuickReplySet(markerFilter.idsFor("replies"));
      if (replySet) {
        res.write(`data: ${JSON.stringify({ quickReplies: replySet.labels })}\n\n`);
        req.log.info({ quickReplySet: replySet.id }, "coach chat quick replies attached");
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) {
        req.log.error({ err: error }, "coach chat stream failed");
        res.write(
          `data: ${JSON.stringify({ error: "The coach is unavailable right now. Please try again." })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  } finally {
    slot.release();
  }
});

export default router;
