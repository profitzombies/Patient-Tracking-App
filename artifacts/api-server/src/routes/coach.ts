import { foldCareTeamTurns } from "../coach/care-team-history";
import express, { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CoachChatBody } from "@workspace/api-zod";
import { selectCompartments } from "../coach/select";
import { buildSystemPrompt, toModelMessages } from "../coach/prompt";
import { demoPatientContext } from "../coach/demo-patient";
import { realPatientContext } from "../coach/real-patient";
import { bearerToken, resolvePatient } from "../lib/patient-auth";
import { loadOrgPolicy } from "../lib/org-policy";
import { detectBackOnTrackFollowUp, generateBackOnTrackTurn } from "../coach/back-on-track";
import { acquireChatSlot, acquireMenuScanSlot } from "../coach/limits";
import { findProduct, matchProducts, productCardPayload } from "../coach/products";
import { detectRecipeIntent } from "../coach/intent";
import { generateRecipeTurn } from "../coach/recipe";
import { generateLabelChatTurn } from "../coach/label-chat";
import {
  MEAL_KEEP_REPLY,
  detectMealMakeoverFollowUp,
  detectMealVersionChoice,
  generateMealChatTurn,
  generateMealMakeoverTurn,
} from "../coach/meal-chat";
import { isMealCorrectionText } from "../coach/meal-correction";
import { buildMealSlotContext } from "../coach/meal-slot";
import { detectMenuRecipeFollowUp, generateMenuChatTurn } from "../coach/menu-chat";
import { resolvePhotoKind } from "../coach/photo-kind";
import { createPhotoUsageLog } from "../coach/usage";
import { DashSmoother } from "../coach/text-style";
import { MarkerFilter } from "../coach/markers";
import { BrandSpellingSmoother } from "../lib/brand-spelling";
import { MEAL_VERSION_REPLY_SET, firstQuickReplySet } from "../coach/quick-replies";
import {
  UpstreamTimeoutError,
  createUpstreamDeadline,
  keepaliveIntervalMs,
} from "../coach/upstream";
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

/** What a paused coach tells the patient (the app shows it verbatim). */
export const COACH_PAUSED_MESSAGE =
  "Your care team has paused the coach for now. Your diary, check-ins, and photos keep working, and the coach will be back as soon as they turn it on again.";

/**
 * HQ policy read for the pause gate. A policy read failure never blocks
 * coaching: the loader serves its last-known-good policy, and with none at
 * all the coach stays available (logged) rather than failing every patient
 * because a settings read hiccuped.
 */
async function coachAvailable(req: { log: { error: (obj: unknown, msg: string) => void } }): Promise<boolean> {
  try {
    return (await loadOrgPolicy()).coachAvailable;
  } catch (error) {
    req.log.error({ err: error }, "coach availability policy read failed");
    return true;
  }
}

router.get("/coach/availability", async (req, res) => {
  // Only sessions that resolve to a real patient are subject to the pause;
  // the demo persona and staff browsing it always see an available coach.
  if (bearerToken(req) === null) {
    res.json({ available: true, message: null });
    return;
  }
  let auth;
  try {
    auth = await resolvePatient(req);
  } catch (error) {
    req.log.error({ err: error }, "coach availability patient resolution failed");
    res.status(502).json({ error: "Couldn't load your account right now. Please try again.", retryable: true });
    return;
  }
  if (!auth.ok) {
    if (auth.status === 403) {
      res.json({ available: true, message: null });
      return;
    }
    res.status(auth.status).json({ error: auth.error, retryable: true });
    return;
  }
  const available = await coachAvailable(req);
  res.json({ available, message: available ? null : COACH_PAUSED_MESSAGE });
});

router.post("/coach/chat", express.json({ limit: PHOTO_BODY_LIMIT }), async (req, res) => {
  const startedAt = Date.now();
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

    // Care-team turns replay as context-only user notes; the latest turn
    // must still be the patient's own message, so a staff line can never be
    // the thing the model answers.
    const rawHistory = parsed.data.messages.slice(-MAX_HISTORY);
    if (rawHistory[rawHistory.length - 1]?.role !== "user") {
      res.status(400).json({ error: "Last message must be from the user" });
      return;
    }
    const history = foldCareTeamTurns(rawHistory);
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

    // Meal-slot context for card-producing pipelines: an explicit slot pinned
    // by the client wins outright; otherwise the patient's device clock
    // (localTime, sent by the app on every call) yields the default the model
    // falls back to when the patient names no meal. Old clients send neither,
    // and the pipelines keep their legacy defaults.
    const slotContext = buildMealSlotContext(parsed.data);
    req.log.info(
      {
        compartments: selection.ids,
        offeredProducts: offeredProducts.map((p) => p.id),
        slot: slotContext,
      },
      "coach chat compartments selected",
    );

    // Patient context is derived server-side; the client is never trusted
    // for it. Unauthenticated requests (the demo persona) keep the fixed
    // demo seed. A bearer session that resolves to a patients row grounds
    // the coach on THAT patient's live account instead — name, program day,
    // and today's diary totals. The ladder runs before the SSE stream opens
    // so failures stay plain JSON statuses:
    //   401/503 → the session is bad or auth is down; honest retryable
    //     error, never demo data for a possibly-real patient.
    //   403 → a real session that is not a patient (staff browsing the
    //     persona); the demo seed is exactly what they are looking at.
    //   502 → the account exists but its data could not be loaded.
    let patientContext = demoPatientContext();
    let realPatient = false;
    if (bearerToken(req) !== null) {
      let auth;
      try {
        // Consent is enforced at the identity choke point. A photo turn also
        // needs the patient's optional photo-analysis opt-in: declining it
        // must keep every image away from the model, not just hide a button.
        auth = await resolvePatient(req, { consent: image !== undefined ? "photo-analysis" : "required" });
      } catch (error) {
        req.log.error({ err: error }, "coach chat patient resolution failed");
        res.status(502).json({
          error: "Couldn't load your account right now. Please try again.",
          retryable: true,
        });
        return;
      }
      if (auth.ok) {
        // Organization policy: the care team can pause the coach for real
        // patients. Checked before any model call so a paused coach costs
        // nothing and answers the same honest JSON the app renders as its
        // "paused by your care team" state. The demo persona is never paused.
        if (!(await coachAvailable(req))) {
          res.status(503).json({ error: COACH_PAUSED_MESSAGE, retryable: false, coachPaused: true });
          return;
        }
        try {
          patientContext = await realPatientContext(auth.patientId, parsed.data.localDate);
          realPatient = true;
        } catch (error) {
          req.log.error({ err: error }, "coach chat real patient context failed");
          res.status(502).json({
            error: "Couldn't load your account right now. Please try again.",
            retryable: true,
          });
          return;
        }
      } else if (auth.status !== 403 || auth.code !== undefined) {
        // 401/503 are retryable session problems; a consent refusal is a
        // real patient who must act first (never the staff→demo fallback).
        res.status(auth.status).json({
          error: auth.error,
          ...auth.details,
          retryable: auth.code === undefined,
        });
        return;
      }
    }

    // Replies the patient stopped mid-stream arrive flagged; annotate them
    // once here so ALL model pipelines (plain streaming, recipe turns, menu
    // follow-ups) see the interruption note instead of a seemingly complete
    // answer.
    const modelHistory = toModelMessages(history);

    // Which model pipeline answers this turn — failure/completion logs carry
    // it (plus elapsed time) so a mystery error bubble can be traced to the
    // pipeline and duration that produced it.
    let pipeline:
      | "plain"
      | "menu"
      | "meal"
      | "label"
      | "menu-recipe"
      | "meal-makeover"
      | "meal-approved-recipe"
      | "meal-keep"
      | "back-on-track"
      | "recipe"
      | "cravings" = "plain";

    // Token accounting for photo turns: every vision pipeline reports each
    // completed model call's usage under a stage name ("classify", "meal",
    // "menu", "label") and the turn's completion/failure log carries the
    // totals, so the cost of one photo is computable from a single log line
    // instead of estimated. Token counts only — never message content, never
    // the photo. Declared alongside `pipeline` so the catch block can log
    // whatever usage a failed or aborted turn had already accrued.
    const photoUsage = createPhotoUsageLog();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    // Keepalive from stream start until the turn ends. SSE comment lines are
    // invisible to consumers (the app parses only `data:` lines) but keep
    // bytes flowing, so idle-connection proxies never drop the stream during
    // long silent stretches — recipe/cravings/menu turns answer with ONE
    // non-streaming model call (worst case several in a row) and previously
    // wrote nothing at all until the last call finished.
    const keepalive = setInterval(() => {
      if (!abort.signal.aborted && !res.writableEnded) {
        res.write(": keepalive\n\n");
      }
    }, keepaliveIntervalMs());

    try {
      // ── Photo turns ─────────────────────────────────────────────────────
      // The Library/Diary flows label their photos ("meal"); the standalone
      // menu screen and older clients say "menu". The chat composer's camera
      // sends NO kind — the patient just snapped whatever is in front of
      // them — so a tiny vision triage looks at the photo and picks the
      // pipeline itself: a menu gets the ordering scan, a Nutrition Facts
      // panel the label reader, anything else the plate-logging analysis
      // (whose not-food outcome reads junk photos warmly). The keepalive
      // above is already running, so the extra call never leaves the stream
      // silent.
      //
      // Photo turns are the chat's slowest, so they narrate and measure
      // themselves. The stream gets {stage:"received"} the moment it opens
      // and {stage:"reading_meal"|"reading_menu"|"reading_label"} once the
      // pipeline is known, feeding the app's staged progress lines (old
      // clients skip unknown data events, so the extra events are
      // backward-safe). The completion log gets the per-stage spans
      // (classifyMs, analysisMs, firstTokenMs) plus per-stage token usage
      // (prompt/completion/reasoning per AI call, via photoUsage) so a slow
      // turn names its slow stage and an expensive one its cost — durations,
      // outcomes, and token counts only, never the photo itself.
      const photoTimings: {
        classifyMs?: number;
        analysisMs?: number;
        firstTokenMs?: number;
        speculated?: boolean;
        speculationDiscarded?: boolean;
      } = {};
      const writeStage = (
        stage: "received" | "reading_meal" | "reading_menu" | "reading_label",
      ) => {
        if (!abort.signal.aborted && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ stage })}\n\n`);
        }
      };
      if (image !== undefined) {
        writeStage("received");
      }

      // A typed fix for a misread plate: the client re-attached the SAME
      // held photo and the patient's words ride as the message text. Their
      // naming becomes ground truth for what the foods are (portions still
      // come from the photo). The fixed photo replay lines never read as
      // corrections, so plain sends, retakes, and retries stay fresh,
      // uncorrected reads. Derived up here because the speculative read
      // below needs it before the pipeline is even known.
      const mealCorrection =
        image !== undefined && isMealCorrectionText(latest.content) ? latest.content : undefined;

      // A kindless chat-camera photo is overwhelmingly a plate, yet the
      // triage that confirms it used to cost a full serial round trip before
      // the real read even started. Now the meal analysis launches alongside
      // the triage and the router merely decides whether to KEEP it: "meal"
      // awaits the already-running read, "menu"/"label" cancel it and run
      // their own scan exactly as before. One discarded nano-priced call on
      // the rare menu/label detour buys the common case its head start.
      let speculativeMeal: ReturnType<typeof generateMealChatTurn> | undefined;
      let speculationStartedAt: number | undefined;
      const speculationCancel = new AbortController();
      let resolvedPhotoKind = image === undefined ? undefined : latest.photoKind;
      if (image !== undefined && latest.photoKind === undefined) {
        const classifyStartedAt = Date.now();
        // Triage starts first so its model call is provably the first on the
        // wire (logs and route tests key off that order), then the
        // speculative read follows in the same tick.
        const triage = resolvePhotoKind({
          image,
          onUsage: photoUsage.recorder("classify"),
          signal: abort.signal,
          log: req.log,
        });
        speculationStartedAt = Date.now();
        // A discarded speculation that already finished still recorded its
        // usage under "meal" — the log's speculationDiscarded flag is what
        // marks those tokens as the speed-up's overhead. One cancelled
        // before the upstream answered has no usage to report (the gateway
        // may still bill its prompt, but that number never reaches us).
        speculativeMeal = generateMealChatTurn({
          image,
          patient: patientContext,
          slot: slotContext,
          correction: mealCorrection,
          onUsage: photoUsage.recorder("meal"),
          signal: AbortSignal.any([abort.signal, speculationCancel.signal]),
          log: req.log,
        });
        photoTimings.speculated = true;
        // The discarded path must never surface as an unhandled rejection;
        // the kept path awaits the SAME promise below and still sees real
        // errors.
        speculativeMeal.catch(() => {});
        try {
          resolvedPhotoKind = await triage;
        } catch (error) {
          // Triage only throws on an upstream timeout — the turn's honest
          // failure. Reel the speculative read in with it.
          speculationCancel.abort();
          throw error;
        }
        photoTimings.classifyMs = Date.now() - classifyStartedAt;
        req.log.info(
          { resolvedPhotoKind, classifyMs: photoTimings.classifyMs },
          "coach chat photo triaged",
        );
        // Name the route on the wire: the client stamps it onto the photo
        // turn so a retry of this exact turn sends photoKind explicitly
        // instead of triaging the same photo again (a second triage is a
        // second model call that could pick the other pipeline).
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ photoKind: resolvedPhotoKind })}\n\n`);
        }
      }

      // ── Meal photo turn ─────────────────────────────────────────────────
      // A plate to log, not a menu to scan: the vision analysis identifies
      // the VISIBLE foods with committed portion estimates and the reply
      // carries an editable one-serving meal card (recipe payload, mode
      // "meal"). Every item is also judged against the Approved Foods
      // catalog: a plate with off-list items closes with the makeover offer
      // and the curated yes/no chips ride the turn (next to the client's own
      // "Retake photo" chip); a fully approved plate gets a one-line nod and
      // no chips. Non-food and unreadable photos are warm conversational
      // outcomes, never errors.
      if (image !== undefined && resolvedPhotoKind === "meal") {
        pipeline = "meal";
        writeStage("reading_meal");
        // analysisMs is the read's full wall span: from its actual start
        // (which overlaps the classify when the read was speculative).
        const analysisStartedAt = speculationStartedAt ?? Date.now();
        const mealTurn = speculativeMeal
          ? await speculativeMeal
          : await generateMealChatTurn({
              image,
              patient: patientContext,
              slot: slotContext,
              correction: mealCorrection,
              onUsage: photoUsage.recorder("meal"),
              signal: abort.signal,
              log: req.log,
            });
        photoTimings.analysisMs = Date.now() - analysisStartedAt;
        if (!abort.signal.aborted) {
          photoTimings.firstTokenMs = Date.now() - startedAt;
          res.write(`data: ${JSON.stringify({ content: mealTurn.reply })}\n\n`);
          if (mealTurn.card) {
            res.write(`data: ${JSON.stringify({ card: mealTurn.card })}\n\n`);
          }
          // Off-list items spotted: the reply just closed with the makeover
          // offer, so the curated yes/no chips ride this turn (the verdict
          // itself never rides any payload — chat wording only).
          if (mealTurn.offerMakeover) {
            const yesNo = firstQuickReplySet(["yes_no"]);
            if (yesNo) {
              res.write(`data: ${JSON.stringify({ quickReplies: yesNo.labels })}\n\n`);
            }
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            {
              pipeline,
              elapsedMs: Date.now() - startedAt,
              outcome: mealTurn.outcome,
              items: mealTurn.itemCount,
              corrected: mealTurn.corrected,
              offPlan: mealTurn.offPlanCount,
              ...photoTimings,
              usage: photoUsage.snapshot(),
            },
            "coach meal photo turn completed",
          );
        }
        return;
      }

      // ── Nutrition label turn ────────────────────────────────────────────
      // A packaged food's Nutrition Facts panel: the label reader transcribes
      // the printed values (never estimates) and the reply reads them back,
      // then asks what the product is called. The validated read rides the
      // dedicated `labelDraft` event — no card here, because the client holds
      // the draft through the name conversation and builds the food card
      // locally once the name settles. Old clients ignore the extra event and
      // simply see the text. Unreadable and not-a-label photos are warm
      // conversational outcomes, never errors.
      if (image !== undefined && resolvedPhotoKind === "label") {
        pipeline = "label";
        // The speculative plate read guessed wrong; cut it loose before the
        // label read runs so its upstream slot frees immediately.
        if (speculativeMeal) {
          speculationCancel.abort();
          photoTimings.speculationDiscarded = true;
        }
        writeStage("reading_label");
        const analysisStartedAt = Date.now();
        const labelTurn = await generateLabelChatTurn({
          image,
          patient: patientContext,
          slot: slotContext,
          onUsage: photoUsage.recorder("label"),
          signal: abort.signal,
          log: req.log,
        });
        photoTimings.analysisMs = Date.now() - analysisStartedAt;
        if (!abort.signal.aborted) {
          photoTimings.firstTokenMs = Date.now() - startedAt;
          res.write(`data: ${JSON.stringify({ content: labelTurn.reply })}\n\n`);
          if (labelTurn.draft) {
            res.write(`data: ${JSON.stringify({ labelDraft: labelTurn.draft })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            {
              pipeline,
              elapsedMs: Date.now() - startedAt,
              outcome: labelTurn.outcome,
              flagged: labelTurn.draft?.flagged === true,
              ...photoTimings,
              usage: photoUsage.snapshot(),
            },
            "coach label photo turn completed",
          );
        }
        return;
      }

      // ── Menu photo turn ─────────────────────────────────────────────────
      // The photo goes through the same grounded vision scan as the
      // standalone menu-scan screen, and the structured result is formatted
      // into a conversational reply: picks, skips, then a closing offer to
      // turn one into a custom recipe (sent with the curated yes/no chips).
      // Not-a-menu / unreadable photos are warm conversational outcomes here,
      // never error events. The photo lives in this request's memory only.
      if (image !== undefined) {
        pipeline = "menu";
        // The speculative plate read guessed wrong; cut it loose before the
        // menu scan runs so its upstream slot frees immediately.
        if (speculativeMeal) {
          speculationCancel.abort();
          photoTimings.speculationDiscarded = true;
        }
        writeStage("reading_menu");
        const analysisStartedAt = Date.now();
        const menuTurn = await generateMenuChatTurn({
          image,
          patient: patientContext,
          onUsage: photoUsage.recorder("menu"),
          signal: abort.signal,
          log: req.log,
        });
        photoTimings.analysisMs = Date.now() - analysisStartedAt;
        if (!abort.signal.aborted) {
          photoTimings.firstTokenMs = Date.now() - startedAt;
          res.write(`data: ${JSON.stringify({ content: menuTurn.reply })}\n\n`);
          if (menuTurn.offerRecipe) {
            const yesNo = firstQuickReplySet(["yes_no"]);
            if (yesNo) {
              res.write(`data: ${JSON.stringify({ quickReplies: yesNo.labels })}\n\n`);
            }
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            {
              pipeline,
              elapsedMs: Date.now() - startedAt,
              outcome: menuTurn.outcome,
              order: menuTurn.orderCount,
              avoid: menuTurn.avoidCount,
              ...photoTimings,
              usage: photoUsage.snapshot(),
            },
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
        pipeline = "menu-recipe";
        req.log.info({}, "coach menu recipe follow-up turn");
        const result = await generateRecipeTurn({
          mode: "recipe",
          inspiration: "menu",
          history: modelHistory,
          compartments: selection.compartments,
          patient: patientContext,
          slot: slotContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: result.reply })}\n\n`);
          if (result.card) {
            res.write(`data: ${JSON.stringify({ card: result.card })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { pipeline, elapsedMs: Date.now() - startedAt, card: result.card !== null },
            "coach chat turn completed",
          );
        }
        return;
      }

      // ── Meal makeover follow-ups ────────────────────────────────────────
      // The off-plan callout's closing offer and the swaps reply's version
      // question are server-authored constants, so replayed history contains
      // them verbatim and strict adjacency detectors can route the one-tap
      // answers. Anything richer than a one-tap falls through to plain chat,
      // which reads the same context anyway.

      // Version question answered. "The approved version" builds the real
      // recipe through the recipe pipeline under the cravings-strength
      // approved-only contract (every ingredient must cite a verified
      // catalog id, corrective retry on bad citations); "Keep it as is" is
      // canned with zero model calls, pointing back at the meal card.
      const versionChoice = detectMealVersionChoice(history);
      if (versionChoice === "approved") {
        pipeline = "meal-approved-recipe";
        req.log.info({}, "coach meal approved-version turn");
        const result = await generateRecipeTurn({
          mode: "recipe",
          inspiration: "meal-makeover",
          history: modelHistory,
          compartments: selection.compartments,
          patient: patientContext,
          slot: slotContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: result.reply })}\n\n`);
          if (result.card) {
            res.write(`data: ${JSON.stringify({ card: result.card })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { pipeline, elapsedMs: Date.now() - startedAt, card: result.card !== null },
            "coach chat turn completed",
          );
        }
        return;
      }
      if (versionChoice === "keep") {
        pipeline = "meal-keep";
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: MEAL_KEEP_REPLY })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { pipeline, elapsedMs: Date.now() - startedAt },
            "coach chat turn completed",
          );
        }
        return;
      }

      // A one-tap yes right under the makeover offer: ONE grounded
      // non-streaming turn describing the approved swaps for that exact
      // plate (read from the replayed callout — the photo is never re-sent),
      // closing with the server-authored version question and its dedicated
      // chip pair. When the model gives nothing usable the canned decline
      // goes out with NO version chips: there is no suggestion to choose
      // from, and the choice detector must never fire against that reply.
      if (detectMealMakeoverFollowUp(history)) {
        pipeline = "meal-makeover";
        req.log.info({}, "coach meal makeover turn");
        const makeover = await generateMealMakeoverTurn({
          history: modelHistory,
          compartments: selection.compartments,
          patient: patientContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: makeover.reply })}\n\n`);
          if (makeover.askVersion) {
            res.write(
              `data: ${JSON.stringify({ quickReplies: MEAL_VERSION_REPLY_SET.labels })}\n\n`,
            );
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { pipeline, elapsedMs: Date.now() - startedAt, askVersion: makeover.askVersion },
            "coach chat turn completed",
          );
        }
        return;
      }

      // ── Back-on-track follow-up ─────────────────────────────────────────
      // A one-tap yes right under the coach's proactive stall outreach. The
      // outreach bubble is a fixed client-side string (the mobile app seeds
      // it when the shared stall trigger fires) whose closing offer is
      // duplicated verbatim in back-on-track.ts, so the same strict-adjacency
      // contract routes it: ONE grounded non-streaming turn laying out the
      // reset plan (their own trend, a few days of approved-foods meals,
      // daily logging, the provider check-in as an option). Plain text, no
      // card, no chips — the reply ends on a statement so the thread rests.
      // Real accounts never take this branch: the outreach bubble and its
      // reset plan quote the DEMO patient's stall numbers (weights, weeks),
      // which are not this patient's story. The client only seeds the
      // outreach for the demo persona, so an authenticated turn that happens
      // to match the follow-up shape falls through to plain grounded chat.
      if (!realPatient && detectBackOnTrackFollowUp(history)) {
        pipeline = "back-on-track";
        req.log.info({}, "coach back-on-track turn");
        const turn = await generateBackOnTrackTurn({
          history: modelHistory,
          compartments: selection.compartments,
          patient: patientContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: turn.reply })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { pipeline, elapsedMs: Date.now() - startedAt },
            "coach chat turn completed",
          );
        }
        return;
      }

      // Meal-idea and craving turns switch to the structured JSON pipeline:
      // one non-streaming call that yields a short reply plus a validated
      // recipe card (cravings: approved-foods-only, enforced server-side).
      // Recipe turns use their own prompt, so no product block applies there.
      const intent = detectRecipeIntent(latest.content);
      if (intent) {
        pipeline = intent;
        req.log.info({ intent }, "coach recipe turn");
        const result = await generateRecipeTurn({
          mode: intent,
          history: modelHistory,
          compartments: selection.compartments,
          patient: patientContext,
          slot: slotContext,
          signal: abort.signal,
          log: req.log,
        });
        if (!abort.signal.aborted) {
          res.write(`data: ${JSON.stringify({ content: result.reply })}\n\n`);
          if (result.card) {
            res.write(`data: ${JSON.stringify({ card: result.card })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          req.log.info(
            { pipeline, elapsedMs: Date.now() - startedAt, card: result.card !== null },
            "coach chat turn completed",
          );
        }
        return;
      }

      // Control markers (product recommendation, one-tap answer set) are
      // signals, never visible text: the filter strips them from the stream
      // (even split across chunks) and records the ids for validation below.
      const markerFilter = new MarkerFilter(["product", "replies"]);

      // The brand comes out THINNR no matter what the model echoes from the
      // program materials (some of which misspell it "THINNER"): the shared
      // smoother rewrites capitalized misspellings even when they arrive
      // split across chunks; lowercase English "thinner" passes through.
      const brandSmoother = new BrandSpellingSmoother();

      // The no-dash voice rule is enforced structurally on the way out (the
      // prompt alone is not a guarantee), with chunk-spanning bridges like
      // "word " + "— word" handled by the smoother's held-back tail.
      const dashSmoother = new DashSmoother();

      // Idle deadline, restarted on every chunk: it bounds SILENCE (the
      // reasoning preamble before the first token, or an upstream that wedges
      // mid-stream), not total reply length. Expiry aborts only the child
      // signal — the route's catch still reads `abort.signal` to tell a
      // client disconnect (stay silent) from this failure (error event).
      const deadline = createUpstreamDeadline(abort.signal);
      try {
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
          { signal: deadline.signal },
        );

        for await (const chunk of stream) {
          deadline.touch();
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            const visible = dashSmoother.push(brandSmoother.push(markerFilter.push(delta)));
            if (visible) {
              res.write(`data: ${JSON.stringify({ content: visible })}\n\n`);
            }
          }
        }
      } catch (error) {
        // The stream died mid-reply: drain what the marker filter and the
        // brand/dash smoothers were still holding back, so every character
        // cleared for display reaches the wire before the error event. (The
        // client may replace the partial text with the error bubble, but the
        // wire contract stays no-drop for any consumer that keeps partials.)
        if (!abort.signal.aborted) {
          const held =
            dashSmoother.push(brandSmoother.push(markerFilter.flush()) + brandSmoother.flush()) +
            dashSmoother.flush();
          if (held) {
            res.write(`data: ${JSON.stringify({ content: held })}\n\n`);
          }
        }
        // Name the timeout so the failure log says WHY the turn died instead
        // of a generic aborted-request error.
        throw deadline.expired
          ? new UpstreamTimeoutError("coach chat completion", deadline.idleMs, { cause: error })
          : error;
      } finally {
        deadline.finish();
      }
      const tail =
        dashSmoother.push(brandSmoother.push(markerFilter.flush()) + brandSmoother.flush()) +
        dashSmoother.flush();
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
      req.log.info({ pipeline, elapsedMs: Date.now() - startedAt }, "coach chat turn completed");
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (abort.signal.aborted) {
        // The client went away mid-turn (stop, app closed, or a proxy cut
        // the connection). Nothing can be written, but the log keeps dropped
        // streams observable instead of vanishing without a trace.
        req.log.info(
          { pipeline, elapsedMs, usage: photoUsage.snapshot() },
          "coach chat turn aborted by client",
        );
      } else {
        req.log.error(
          { err: error, pipeline, elapsedMs, usage: photoUsage.snapshot() },
          "coach chat stream failed",
        );
        res.write(
          `data: ${JSON.stringify({ error: "The coach is unavailable right now. Please try again." })}\n\n`,
        );
      }
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  } finally {
    releaseVisionSlot?.();
    slot.release();
  }
});

export default router;
