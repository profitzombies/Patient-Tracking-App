import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CoachChatBody } from "@workspace/api-zod";
import { selectCompartments } from "../coach/select";
import { buildSystemPrompt } from "../coach/prompt";
import { demoPatientContext } from "../coach/demo-patient";
import { acquireChatSlot } from "../coach/limits";
import { findProduct, matchProducts, productCardPayload } from "../coach/products";
import { ProductMarkerFilter } from "../coach/product-marker";

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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
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
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { signal: abort.signal },
      );

      // Product markers are control signals, never visible text: the filter
      // strips them from the stream (even split across chunks) and records
      // the ids for validation below.
      const markerFilter = new ProductMarkerFilter();
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
      const chosenId = markerFilter.ids.find((id) => offeredIds.has(id));
      const chosen = chosenId ? findProduct(chosenId) : undefined;
      if (chosen) {
        res.write(
          `data: ${JSON.stringify({ card: { kind: "product", payload: productCardPayload(chosen) } })}\n\n`,
        );
        req.log.info({ product: chosen.id }, "coach chat product card attached");
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
