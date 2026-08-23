import express, { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CoachChatBody } from "@workspace/api-zod";
import { selectCompartments } from "../coach/select";
import { buildSystemPrompt, toModelMessages } from "../coach/prompt";
import { demoPatientContext } from "../coach/demo-patient";
import { acquireChatSlot, acquireMenuScanSlot } from "../coach/limits";
import { findProduct, matchProducts, productCardPayload } from "../coach/products";
import { detectRecipeIntent } from "../coach/intent";
import { generateRecipeTurn } from "../coach/recipe";
import { detectMenuRecipeFollowUp, generateMenuChatTurn } from "../coach/menu-chat";
import { MarkerFilter } from "../coach/markers";
import { firstQuickReplySet } from "../coach/quick-replies";
import {
  INVALID_PHOTO_MESSAGE,
  MAX_PHOTO_BYTES,
  PHOTO_BODY_LIMIT,
  PHOTO_DATA_URI_PATTERN,
  PHOTO_TOO_LARGE_MESSAGE,
  decodedPhotoBytes,
} from "../lib/photo-guards";

const router: IRouter = Router();

/**
 * Absolute request path — app.ts skips the global 100kb JSON parser here so
 * the route-local parser below can accept a photo-sized body (a menu photo
 * may ride the latest message as a data URI).
 */
export const COACH_CHAT_PATH = "/api/coach/chat";

/** Most recent messages kept per request; the client sends session history. */
const MAX_HISTORY = 12;

router.post("/coach/chat", express.json({ limit: PHOTO_BODY_LIMIT }), async (req, res) => {
  // Limit first: this endpoint spends paid model credits, so even invalid
  // spam should burn the caller's budget, not the server's CPU.
  const slot = acquireChatSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    // `retryable: false` marks denials that cannot clear soon (daily budget
    // spent) so the client can drop its Retry control; busy/rapid denials
    // stay retryable. Absent means retryable — older bodies default that way.
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }

  let releaseVisionSlot: (() => void) | null = null;
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

    // A photo is honored only on the LATEST user message. Replayed history is
    // text-only by contract (the client strips photos when rebuilding it), so
    // this is the single image that can ever reach the vision model. Guards
    // run before the stream opens, keeping failures plain JSON statuses.
    const image = latest.image;
    if (image !== undefined) {
      if (!PHOTO_DATA_URI_PATTERN.test(image)) {
        res.status(400).json({ error: INVALID_PHOTO_MESSAGE });
        return;
      }
      if (decodedPhotoBytes(image) > MAX_PHOTO_BYTES) {
        res.status(413).json({ error: PHOTO_TOO_LARGE_MESSAGE });
        return;
      }
      // Photo turns are vision calls priced like menu scans, so they consume
      // the scanner's shared budget on top of the chat slot already held.
      const visionSlot = acquireMenuScanSlot(req.ip ?? "unknown");
      if (!visionSlot.ok) {
        res
          .status(visionSlot.status)
          .json({ error: visionSlot.message, retryable: visionSlot.retryable });
        return;
      }
      releaseVisionSlot = visionSlot.release;
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
    // once here so ALL model pipelines (plain streaming, recipe turns, menu
    // follow-ups) see the interruption note instead of a seemingly complete
    // answer.
    const modelHistory = toModelMessages(history);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
      // ── Menu photo turn ─────────────────────────────────────────────────
      // The photo goes through the same grounded vision scan as the
      // standalone menu-scan screen, and the structured result is formatted
      // into a conversational reply: picks, skips, then a closing offer to
      // turn one into a custom recipe (sent with the curated yes/no chips).
      // Not-a-menu / unreadable photos are warm conversational outcomes here,
      // never error events. The photo lives in this request's memory only.
      if (image !== undefined) {
        const menuTurn = await generateMenuChatTurn({
          image,
          patient: patientContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: menuTurn.reply })}\n\n`);
          if (menuTurn.offerRecipe) {
            const yesNo = firstQuickReplySet(["yes_no"]);
            if (yesNo) {
              res.write(`data: ${JSON.stringify({ quickReplies: yesNo.labels })}\n\n`);
            }
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { outcome: menuTurn.outcome, order: menuTurn.orderCount, avoid: menuTurn.avoidCount },
            "coach menu photo turn completed",
          );
        }
        return;
      }

      // ── Menu recipe follow-up ───────────────────────────────────────────
      // A short yes to the menu reply's closing offer routes into the recipe
      // pipeline seeded with the menu context — already present in the
      // replayed history as the suggestions text, so the photo is never
      // re-sent.
      if (detectMenuRecipeFollowUp(history)) {
        req.log.info({}, "coach menu recipe follow-up turn");
        const result = await generateRecipeTurn({
          mode: "recipe",
          inspiration: "menu",
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
          // Deliberately NO reasoning_effort override: a trial of "low"
          // (2026-08-23) kept answers grounded and trimmed the worst silent
          // wait, but suppressed the optional one-tap replies marker on
          // questions that reliably get chips at the default effort (0/5 vs
          // 2/2 runs). The typed-out reveal in the app covers the wait
          // instead; don't lower effort without re-checking marker emission.
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
    releaseVisionSlot?.();
    slot.release();
  }
});

export default router;
