/**
 * Chat state for the THINNR coach.
 *
 * DEMO persona history lives in React state on purpose: no database, no
 * AsyncStorage. A fresh app launch always starts a fresh conversation.
 * REAL patient accounts persist the conversation to the account instead:
 * on open the stored transcript is loaded back, and every message is
 * appended once it is FINAL — user turns at send, assistant replies only
 * when they reach `done` (stopped ones included), never mid-stream and
 * never error bubbles — so what is stored is exactly what was on screen.
 * Message shape carries an optional `card` slot so later work can attach
 * rich cards (recipes, products) to assistant replies without changing this
 * contract.
 *
 * The thread never opens cold: each demo session (and the first-ever open
 * of a real account) seeds one short, fixed coach greeting as the first
 * assistant message (see buildGreetingMessage), so the chat reads like a
 * conversation already in progress rather than a blank prompt box. A real
 * account with stored history resumes it instead of greeting again.
 *
 * Paced reveal: the reasoning model spends nearly all its latency thinking,
 * then the whole reply bursts out in under a second (recipe turns arrive as
 * one chunk). Network deltas therefore land in a hidden buffer and a timer
 * reveals them into `message.text` a few characters at a time, so replies
 * visibly type out. The pacing lives HERE — not in the UI layer — because
 * `text` must always be exactly what the patient has seen: stop() keeps the
 * revealed prefix and discards the rest, and a reply (plus any held card /
 * quick-reply suggestion) only finalizes to `done` once the reveal has
 * drained, so chips and cards can never appear before their text.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePatient } from '@/context/PatientContext';
import {
  usePatientAccount,
  type ChatThreadSnapshot,
  type ChatWireMessage,
  type PatientDataApi,
} from '@/context/PatientAccountContext';
import { ENROLLMENT_DAYS, PATIENT_PROFILE, type MealSlot } from '@/data/patient-data';
import { localTodayKey } from '@/lib/live-patient-entry';
import { BACK_ON_TRACK_OFFER, type NudgeAssessment } from '@/data/stall-nudge';
import {
  streamCoachChat,
  type CoachChatRequestBody,
  type CoachRequestMessage,
  type CoachStage,
} from '@/lib/coach-api';
import { parseRecipeCardPayload, type AiRecipeSuggestion } from '@/lib/ai-recipe';
import { parseLabelDraft, type LabelDraft, type LabelFoodCardPayload } from '@/lib/label-food';
import { isMealCorrectionText } from '@/lib/meal-correction';
import { localTimeForDate } from '@/lib/meal-slot';
import { toTitleCase } from '@/lib/title-case';

/** Rich-card slot rendered under an assistant message (see CoachCardSlot). */
export interface CoachCard {
  kind: string;
  payload: unknown;
}

/**
 * What a photo turn's picture shows — decides which server pipeline answers
 * it: "menu" runs the restaurant menu scan, "meal" the plate-logging
 * analysis that returns an editable meal card, "label" the Nutrition Facts
 * reader that opens the name-then-food-card conversation. Turns sent
 * without a kind (the chat composer's camera) let the server look at the
 * photo and decide.
 */
export type PhotoKind = 'menu' | 'meal' | 'label';

/** Options for sendPhoto beyond the pipeline kind. */
export interface SendPhotoOptions {
  /**
   * Diary slot the capture flow already knows it is filling (groundwork for
   * the diary's per-meal camera). Rides the request so the server pins the
   * card's slot — overriding both a named meal and the clock — and is kept
   * on the photo message so retries re-send it.
   */
  mealSlot?: MealSlot;
}

export interface CoachMessage {
  id: string;

  role: 'user' | 'assistant';

  /**
   * For a streaming assistant reply this is the REVEALED text — the exact
   * characters the patient has seen so far, not everything that has arrived
   * over the network (see the reveal buffer below).
   */
  text: string;

  status: 'streaming' | 'done' | 'error';
  /**
   * True when the patient stopped this reply mid-stream: the kept text is an
   * incomplete fragment. Carried into later requests so the server can tell
   * the model the reply was interrupted (and used for the bubble's label).
   */

  stopped?: boolean;

  card?: CoachCard;

  /** Assistant messages: id of the user message this reply answers. */
  replyToId?: string;

  /**
   * Server-curated one-tap answer labels tailored to this reply's closing
   * question. Absent (never free-form model text) when the server made no
   * suggestion — the chat screen then falls back to its static yes/no pair.
   */
  quickReplies?: string[];

  /**
   * User messages only: the photo this turn sent (menu or meal), kept in
   * client state so the bubble can render it and a failed turn can retry
   * with the same photo in one tap (no re-take). `text` still carries the
   * fixed replay line the model reads — the bubble renders the photo
   * instead of it. `kind` routes the retry to the same server pipeline and
   * drives the chat screen's "Retake photo" chip (meal turns only).
   * `mealSlot` is the diary slot the capture flow pinned; retries re-send
   * it so the card still preselects that slot.
   *
   * `reused` marks a typed-correction turn: the photo here is the SAME held
   * photo from an earlier meal turn, re-attached so the server can re-read
   * it under the patient's words. The bubble renders the typed text (the
   * photo already appears upthread); the field exists so a failed
   * correction can retry with the photo and the retake chip keeps working
   * under the corrected reply.
   */
  photo?: {
    uri: string;
    width: number;
    height: number;
    kind?: PhotoKind;
    mealSlot?: MealSlot;
    reused?: boolean;
    /**
     * Real accounts only: object path of the per-patient stored copy.
     * Stamped once the background upload lands; hydrated turns arrive with
     * it (their `uri` is the stored copy's display URL). Persistence sends
     * this path — never image bytes — so photo bubbles survive reload.
     */
    path?: string;
  };

  /**
   * Error messages only: false when the server declared the failure final —
   * retrying now cannot help (e.g. the coach's daily budget is spent until
   * tomorrow) — so the chat screen hides its RETRY chip. True for transient
   * failures (busy, rapid-fire, outages), where retrying plausibly helps.
   */
  retryable?: boolean;

  /**
   * Rendered nowhere, but still replayed to the model. Set on the seeded
   * greeting when a photo opens the session: the transcript then starts
   * with the patient's photo, while the request history still tells the
   * model the patient was already greeted (so it never greets twice).
   */
  hidden?: boolean;
}

interface CoachChatContextValue {
  messages: CoachMessage[];
  isStreaming: boolean;
  /**
   * Progress narration for the in-flight photo turn (null on text turns and
   * between exchanges). Set to "received" the instant a photo send starts —
   * the acknowledgment must not wait on the network — then upgraded by the
   * server's stage events once the pipeline is known; cleared on finalize,
   * error, and stop. The chat screen captions the waiting bubble with it
   * while no reply text is on screen yet.
   */
  pendingStage: CoachStage | null;
  send: (text: string) => void;
  /**
   * Sends a photo as its own user turn: the bubble shows the photo and the
   * request carries it (as a data URI) on the final message ONLY — older
   * photo turns replay as fixed text, so a photo is never uploaded twice.
   * `kind` picks the server pipeline: "meal" turns come back with an
   * editable meal card and keep the patient's own photo as the card's
   * picture. Omit it (the chat camera) and the server looks at the photo
   * and routes it itself. `options.mealSlot` pins the card's diary slot for
   * entry points that already know it. No-op while a reply is in flight.
   */
  sendPhoto: (
    photo: { uri: string; width: number; height: number },
    kind?: PhotoKind,
    options?: SendPhotoOptions,
  ) => void;
  /**
   * Resends the question behind a failed reply: the error bubble is swapped
   * in place for a fresh streaming bubble and the same request is made again
   * (including the photo, when the failed turn sent one). No-op while a
   * reply is in flight or when the id is not a failed reply.
   */
  retry: (assistantMessageId: string) => void;
  /**
   * Aborts the in-flight reply: keeps exactly the text revealed so far as a
   * finished message flagged `stopped` (drops a still-empty bubble, discards
   * anything buffered but never shown) and unlocks the input. A card the
   * server already attached survives the stop. No-op when nothing is
   * streaming.
   */
  stop: () => void;
  /** Looks up an AI recipe suggestion received this session (by card id). */
  getRecipeSuggestion: (id: string) => AiRecipeSuggestion | undefined;
  /** Caches a generated photo on a suggestion so re-opens don't regenerate. */
  setSuggestionPhoto: (id: string, photoUri: string) => void;
  /**
   * Active label-to-food conversation (null when none). While set, send()
   * resolves the patient's text client-side (name, confirm, rename) instead
   * of calling the server; the chat screen can read the phase for its
   * affordances.
   */
  labelFlow: LabelFlowState | null;
  /**
   * Puts the flow into `renaming` for the given food-card message: the next
   * text the patient sends renames that card in place (Title Case) instead
   * of reaching the server. No-op on unknown ids, non-food cards, cards
   * already added, or while a reply is in flight.
   */
  beginLabelRename: (cardMessageId: string) => void;
  /**
   * Marks a food card's payload as added (to which slot, and how many
   * servings the entry logged) after Add saved the custom food and logged
   * the entry — the card then freezes so a double tap cannot save twice.
   */
  markLabelFoodAdded: (cardMessageId: string, slot: MealSlot, quantity?: number) => void;
  /** Drops the session-only patient conversation before signing out. */
  clearLocalState: () => void;
}

const CoachChatContext = createContext<CoachChatContextValue | null>(null);

/**
 * Client keeps its request in step with the server-side history cap. Patient
 * program context (name, day, phase) is derived server-side — from the demo
 * seed, or from the signed-in account's own data — the request carries only
 * the messages.
 */
const MAX_REQUEST_MESSAGES = 12;

/**
 * Reveal cadence. Every tick shows the next few buffered characters; when a
 * network burst outruns the pace the chunk grows with the backlog
 * (pending / REVEAL_CATCHUP_DIVISOR), so a long reply catches up smoothly —
 * fast while far behind, easing back to the base pace as the buffer drains —
 * and still finishes typing within a few seconds. Exported so the coach-chat
 * regression suite can derive its wait budgets from the real cadence.
 */
export const REVEAL_TICK_MS = 32;
export const REVEAL_MIN_CHARS_PER_TICK = 3;
export const REVEAL_CATCHUP_DIVISOR = 30;

/**
 * Per-reply reveal bookkeeping. Lives outside React state: ticks mutate
 * `pending` and read flags synchronously, while state only ever receives the
 * revealed characters. Single-flight sends mean at most one of these exists.
 */
interface RevealState {
  assistantId: string;
  /** Arrived over the network but not yet shown to the patient. */
  pending: string;
  /** Network stream finished cleanly; finalize once `pending` drains. */
  networkDone: boolean;
  /** Held until the reveal finishes so a card never precedes its text. */
  card?: CoachCard;
  /** Held like the card so chips can never appear before the text is done. */
  quickReplies?: string[];
  /** Held like the card: a label read opens its flow once the text is done. */
  labelDraft?: LabelDraft;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * Takes the next chunk to reveal off the buffer: at least the base pace,
 * more when the backlog is deep, and never splitting a surrogate pair so a
 * multi-code-unit character can't flash as a broken glyph mid-reveal.
 */
function takeRevealChunk(reveal: RevealState): string {
  const size = Math.max(
    REVEAL_MIN_CHARS_PER_TICK,
    Math.ceil(reveal.pending.length / REVEAL_CATCHUP_DIVISOR),
  );
  let cut = Math.min(reveal.pending.length, size);
  const lastCode = reveal.pending.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff && cut < reveal.pending.length) cut += 1;
  const chunk = reveal.pending.slice(0, cut);
  reveal.pending = reveal.pending.slice(cut);
  return chunk;
}

/**
 * Replay text for photo turns. The photo itself is uploaded only on the turn
 * being answered; when the thread is rebuilt for later requests this fixed
 * line stands in for the photo so the model still reads a natural
 * conversation.
 */
export const MENU_PHOTO_MESSAGE_TEXT = 'I sent a photo of a restaurant menu.';

/** Replay text for meal photo turns (see MENU_PHOTO_MESSAGE_TEXT). */
export const MEAL_PHOTO_MESSAGE_TEXT = 'I sent a photo of my meal.';

/** Replay text for nutrition label photo turns (see MENU_PHOTO_MESSAGE_TEXT). */
export const LABEL_PHOTO_MESSAGE_TEXT = 'I sent a photo of a nutrition label.';

/** Replay text for photo turns sent without a kind (the server decides). */
export const PHOTO_MESSAGE_TEXT = 'I sent a photo.';

// ─── Label flow: photographed Nutrition Facts → named custom food ──────────
//
// A label photo turn ends with the coach asking what the product is called
// (the one thing the panel never prints). The streamed `labelDraft` is held
// HERE, in client state — the follow-up name conversation is deterministic
// and never relies on model recall. While a flow is active, send()
// resolves the patient's text client-side (no network): name → confirm
// (one-tap chips) → client-built "food" card; a rename, from the card or by
// typing, edits the held name or the card payload in place. Only the
// card's Add button touches patient state.

export type LabelFlowPhase = 'awaiting-name' | 'confirming' | 'renaming';

export interface LabelFlowState {
  phase: LabelFlowPhase;
  /** The held server transcription this conversation is about. */
  draft: LabelDraft;
  /** Proposed product name, already Title Case (confirming phase). */
  name?: string;
  /** Id of the chat message whose food card is being renamed. */
  cardMessageId?: string;
}

/** One-tap labels on the confirm bubble; send() matches them exactly. */
export const LABEL_CONFIRM_CREATE = 'Create the food';
export const LABEL_CONFIRM_FIX = 'Fix the name';

/**
 * The confirm question. The ONLY client-built bubble that ends with "?" —
 * so it must carry its own quick replies (the two labels above), keeping
 * the chat screen's fallback yes/no chips from ever appearing under it.
 */
export function labelConfirmText(name: string): string {
  return `So I'll call it ${name}. Ready to turn it into a food you can log anytime, or want to fix the name first?`;
}

/** Reply to the Fix-the-name chip. Never ends "?" (no chips belong here). */
export const LABEL_RENAME_ASK =
  "No problem. Type the name exactly how you want it and I'll use that.";

/** Bubble above the food card. Never ends "?" — the card is the affordance. */
export const LABEL_CARD_INTRO =
  'Here it is. Look it over, pick the meal it goes under, and tap Add when it reads right.';

/** Acknowledges a rename of an existing card. Never ends "?". */
export function labelRenamedAck(name: string): string {
  return `Done, it's ${name} now.`;
}

/**
 * True when the chat should offer its "Retake photo" chip: the latest
 * message is a finished (done or error) assistant reply to a MEAL photo
 * turn, and nothing is currently streaming. Deliberately latest-only — a
 * retake always starts a fresh capture, so offering it under stale replies
 * higher up the thread would only clutter the conversation. Lives here (not
 * in the screen) so the no-credit suites can drive it against real context
 * state.
 */
export function offersMealPhotoRetake(messages: CoachMessage[], isStreaming: boolean): boolean {
  if (isStreaming) return false;
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'assistant' || !latest.replyToId) return false;
  if (latest.status !== 'done' && latest.status !== 'error') return false;
  const origin = messages.find(m => m.id === latest.replyToId);
  if (!origin?.photo) return false;
  if (origin.photo.kind === 'meal') return true;
  // A chat-camera photo sent without a kind: the server routed it, and a
  // meal card coming back is the tell that the meal pipeline answered.
  if (origin.photo.kind !== undefined) return false;
  const payload = latest.card?.payload as { mode?: unknown } | null | undefined;
  return latest.card?.kind === 'recipe' && payload?.mode === 'meal';
}

/**
 * The user photo turn a typed correction would re-read, or null when the
 * conversation is not in that spot. Mirrors offersMealPhotoRetake's
 * adjacency (latest-only, for the same reason) but demands a finished reply
 * WITH a meal card — a correction rebuilds the card from the same photo, so
 * without a card (not-food, unreadable, error) the retake chip is the only
 * fix. The origin must still hold its photo, sent as a meal turn or routed
 * to one by the server. Corrections chain: a correction turn carries the
 * re-used photo itself (kind "meal"), so a second fix finds it here too.
 * Lives here (not in the screen) so the no-credit suites can drive it.
 */
export function findMealCorrectionOrigin(messages: CoachMessage[]): CoachMessage | null {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'assistant' || latest.status !== 'done' || !latest.replyToId) {
    return null;
  }
  const payload = latest.card?.payload as { mode?: unknown } | null | undefined;
  if (latest.card?.kind !== 'recipe' || payload?.mode !== 'meal') return null;
  const origin = messages.find(m => m.id === latest.replyToId);
  if (!origin?.photo) return null;
  if (origin.photo.kind !== undefined && origin.photo.kind !== 'meal') return null;
  return origin;
}

/**
 * Fixed id for the seeded greeting — outside the `coach-${n}` space nextId()
 * generates, so it can never collide with a real message.
 */
export const GREETING_MESSAGE_ID = 'coach-greeting';

/**
 * The warm opener every session starts with. A fixed client-side string in
 * the coach's texting voice — never model output — so it costs nothing and
 * appears instantly. It is a normal `done` assistant message: it rides the
 * request history like anything else (so the model knows the patient was
 * already greeted and won't greet twice), and it deliberately has no
 * `replyToId`, which keeps quick-reply chips off it — the chat screen shows
 * its starter prompts under the greeting instead.
 */
function buildGreetingMessage(): CoachMessage {
  const firstName = PATIENT_PROFILE.name.split(' ')[0] || 'there';
  return {
    id: GREETING_MESSAGE_ID,
    role: 'assistant',
    status: 'done',
    text: `Hey ${firstName}, good to see you. ${ENROLLMENT_DAYS} days in. That's real commitment, and it shows.\n\nWhat's on your mind today? A meal idea, a craving, the exact wording of a rule. I've got you.`,
  };
}

/**
 * The greeting for a real account's FIRST-ever conversation, personalized
 * from the account's own name and program day (loaded with the transcript —
 * never the demo seed). Under two days in, the commitment line is dropped
 * rather than praising a start that just happened. Same fixed id as the demo
 * greeting; the stored row upserts idempotently, and later opens hydrate
 * this message back instead of rebuilding it.
 */
function buildRealGreetingMessage(patient: {
  firstName: string;
  programDay: number;
}): CoachMessage {
  const commitment =
    patient.programDay >= 2
      ? ` ${patient.programDay} days in. That's real commitment, and it shows.`
      : '';
  return {
    id: GREETING_MESSAGE_ID,
    role: 'assistant',
    status: 'done',
    text: `Hey ${patient.firstName}, good to see you.${commitment}\n\nWhat's on your mind today? A meal idea, a craving, the exact wording of a rule. I've got you.`,
  };
}

/**
 * Fixed id for the coach-initiated stall outreach, seeded by the provider
 * effect below when the patient context says the trigger is live. Outside
 * the `coach-${n}` space like the greeting id.
 */
export const OUTREACH_MESSAGE_ID = 'coach-outreach';

/** One-tap answers under the outreach offer. Accept goes to the server. */
export const OUTREACH_ACCEPT = 'Yes, set me up';
export const OUTREACH_DECLINE = 'Not right now';

/** One-tap answers under the decline follow-up; send() matches exactly. */
export const NUDGE_KEEP_WATCH = 'Keep them coming';
export const NUDGE_PAUSE = 'Pause these nudges';

/**
 * Reply to the Not-right-now chip. Ends "?" deliberately: like the label
 * confirm bubble it carries its own quick replies (the two labels above),
 * so the fallback yes/no pair never appears under it.
 */
export const NUDGE_DECLINE_ASK =
  "That's fine, we can pick this up whenever you're ready. Want me to keep checking in like this when your numbers drift, or pause these check-ins for now?";

/** Reply to the Keep-them-coming chip. Never ends "?". */
export const NUDGE_KEEP_ACK =
  "Good. I'll keep watching quietly and only reach out when it matters. The plan is here whenever you want it.";

/** Reply to the Pause chip. Never ends "?". */
export const NUDGE_PAUSE_ACK =
  "Done, these check-ins are paused. You can turn them back on any time from your Daily Check-In screen. Everything else about the program stays exactly the same.";

/**
 * The coach-initiated outreach: the patient's own numbers, invitation
 * framing, then the fixed offer the server's back-on-track branch keys on.
 * A fixed client-side string like the greeting — the model never writes it —
 * so the trend wording is always accurate to the seeded records. The one
 * proactive bubble that ends "?": it carries its own quick replies, and the
 * chat screen lets it offer them despite having no replyToId.
 */
function buildOutreachMessage(assessment: NudgeAssessment): CoachMessage {
  const firstName = PATIENT_PROFILE.name.split(' ')[0] || 'there';
  const lost =
    Math.round((PATIENT_PROFILE.startingWeight - PATIENT_PROFILE.currentWeight) * 10) / 10;
  const level = Math.round(PATIENT_PROFILE.currentWeight);
  const offPlan = assessment.adherence.offPlan;
  return {
    id: OUTREACH_MESSAGE_ID,
    role: 'assistant',
    status: 'done',
    text:
      `${firstName}, I was looking at your numbers today and wanted to reach out myself.\n\n` +
      `You've put in real work. ${lost} pounds down since you started, and that stands. The last three weeks the scale has been holding right around ${level}, and the diary shows off-plan items sneaking in, ${offPlan} of them in the last two weeks. That's not failure, that's a pattern, and patterns can be changed.\n\n` +
      BACK_ON_TRACK_OFFER,
    quickReplies: [OUTREACH_ACCEPT, OUTREACH_DECLINE],
  };
}

/**
 * Serializes a thread message for the chat request. Stopped replies stay in
 * the history (the patient saw their text) but carry the flag through, so the
 * server marks them as interrupted instead of letting the model continue a
 * cut-off sentence. Photo turns serialize as their fixed text — never the
 * image; callers attach the image to the request tail themselves.
 */
const toRequestMessage = (m: CoachMessage): CoachRequestMessage =>
  m.role === 'assistant' && m.stopped
    ? { role: m.role, content: m.text, stopped: true }
    : { role: m.role, content: m.text };

/**
 * Serializes a finalized message into the account-persistence wire shape.
 * `photoPath` is the stored per-patient copy; without one the photo is
 * omitted entirely (the wire carries object paths, never image bytes), so a
 * turn whose upload failed still persists as its replay text.
 */
/**
 * Whether a photo bubble still holds the session-local capture (data:,
 * file:, blob:, ph:, content: — whatever the camera produced) and can
 * therefore re-attach its image to a request. Hydrated bubbles hold the
 * stored copy's https display URL instead; replayed history is text-only
 * per the request contract, so those never re-attach.
 */
function isLocalPhotoUri(uri: string): boolean {
  return !/^https?:/i.test(uri);
}

function toWireMessage(m: CoachMessage, photoPath?: string): ChatWireMessage {
  const wire: ChatWireMessage = { id: m.id, role: m.role, text: m.text };
  if (m.stopped) wire.stopped = true;
  if (m.hidden) wire.hidden = true;
  if (m.card) wire.card = { kind: m.card.kind, payload: m.card.payload };
  if (m.quickReplies && m.quickReplies.length > 0) {
    wire.quickReplies = m.quickReplies.slice(0, 4);
  }
  if (m.replyToId) wire.replyToId = m.replyToId;
  const path = m.photo?.path ?? photoPath;
  if (m.photo && path) {
    wire.photo = {
      path,
      width: m.photo.width,
      height: m.photo.height,
      ...(m.photo.kind ? { kind: m.photo.kind } : {}),
      ...(m.photo.mealSlot ? { mealSlot: m.photo.mealSlot } : {}),
      ...(m.photo.reused ? { reused: true } : {}),
    };
  }
  return wire;
}

/** Rebuilds a stored message for the thread exactly as it last rendered. */
function wireToCoachMessage(w: ChatWireMessage): CoachMessage {
  const m: CoachMessage = { id: w.id, role: w.role, text: w.text, status: 'done' };
  if (w.stopped) m.stopped = true;
  if (w.hidden) m.hidden = true;
  if (w.card) m.card = { kind: w.card.kind, payload: w.card.payload };
  if (w.quickReplies) m.quickReplies = w.quickReplies;
  if (w.replyToId) m.replyToId = w.replyToId;
  if (w.photo?.uri) {
    m.photo = {
      uri: w.photo.uri,
      width: w.photo.width,
      height: w.photo.height,
      path: w.photo.path,
      ...(w.photo.kind ? { kind: w.photo.kind } : {}),
      ...(w.photo.mealSlot ? { mealSlot: w.photo.mealSlot } : {}),
      ...(w.photo.reused ? { reused: true } : {}),
    };
  }
  return m;
}

/** Real clock for the app; suites inject a fixed one via the `now` prop. */
const systemNow = () => new Date();

export function CoachChatProvider({
  children,
  now,
}: {
  children: React.ReactNode;
  /**
   * Injectable wall clock (returns the current Date). Every request body
   * stamps `localTime` from it at send time so the server can derive
   * time-of-day meal-slot defaults; the no-credit suites pass a fixed clock
   * to keep assertions deterministic. Defaults to the real clock.
   */
  now?: () => Date;
}) {
  const clock = now ?? systemNow;
  // Stall-nudge wiring: the patient context owns the trigger math and the
  // persisted guardrails (opt-out, engagement, cooldown); this provider only
  // seeds the outreach bubble and reports engagement back.
  const {
    nudgeAssessment,
    shouldSeedNudgeOutreach,
    recordNudgeSent,
    markNudgeEngaged,
    setNudgeOptOut,
  } = usePatient();
  // Account seam. The demo persona stays session-only; a real account
  // persists the conversation and grounds the coach on its own data.
  // `accountKey` names the thread's owner — any change (sign-in, sign-out, a
  // different patient) resets local chat state wholesale.
  const { account, resolving, getAccessToken } = usePatientAccount();
  const realAccount = !resolving && account.kind === 'real' ? account : null;
  const accountKey = resolving
    ? 'resolving'
    : account.kind === 'real'
      ? `real:${account.patientId}`
      : account.kind;
  // Render-assigned mirrors so callbacks read the CURRENT account without
  // carrying it in their dependency lists.
  const accountRef = useRef({ resolving, kind: account.kind, getAccessToken });
  accountRef.current = { resolving, kind: account.kind, getAccessToken };
  const chatApiRef = useRef<PatientDataApi | null>(realAccount ? realAccount.api : null);
  chatApiRef.current = realAccount ? realAccount.api : null;
  // Lazy initializer: the demo greeting is built once per provider mount —
  // one session, one conversation. Real (and still-resolving) accounts start
  // empty instead: their opener comes from the stored transcript, or is
  // seeded only when the account has none (see the hydration effect).
  const [messages, setMessages] = useState<CoachMessage[]>(() =>
    !resolving && account.kind === 'demo' ? [buildGreetingMessage()] : [],
  );
  const [isStreaming, setIsStreaming] = useState(false);
  // Photo-turn narration for the waiting bubble (see the interface note).
  // Plain state, not part of the reveal bookkeeping: stages only ever
  // relabel the wait, so losing one is cosmetic by design.
  const [pendingStage, setPendingStage] = useState<CoachStage | null>(null);
  const idRef = useRef(0);
  // Session registry of AI recipe suggestions keyed by suggestion id — the
  // preview screen reads full details from here (route params carry only the
  // id). Session-only by design, like the chat itself.
  const suggestionsRef = useRef(new Map<string, AiRecipeSuggestion>());
  // Active label-to-food conversation. State drives the UI; the ref gives
  // send() a synchronous read (a chip tap can land before the re-render).
  const [labelFlow, setLabelFlow] = useState<LabelFlowState | null>(null);
  const labelFlowRef = useRef<LabelFlowState | null>(null);
  const updateLabelFlow = useCallback((next: LabelFlowState | null) => {
    labelFlowRef.current = next;
    setLabelFlow(next);
  }, []);
  // Mirror of `messages` so `send` can snapshot history without re-memoizing;
  // safe because sends are single-flight (inFlightRef) while it lags. Seeded
  // with the same initial array so a send before the first effect run still
  // carries the greeting.
  const messagesRef = useRef<CoachMessage[]>(messages);
  // Single-flight guard: refs update synchronously, so rapid double-taps
  // cannot race ahead of the isStreaming re-render.
  const inFlightRef = useRef(false);
  // Controller for the in-flight request; doubles as the stream generation
  // token — callbacks from a stopped stream see a different controller here
  // and drop themselves, so they can never touch a later exchange's state.
  const abortRef = useRef<AbortController | null>(null);
  // Reveal bookkeeping for the in-flight reply (null when none). Owned by the
  // same lifecycle as abortRef: stop/error/finalize all clear it.
  const revealRef = useRef<RevealState | null>(null);
  // Message ids are the persistence upsert key, so a real account's ids get
  // a per-session nonce: `coach-<nonce>-<n>` can never collide with rows
  // stored by an earlier app session. Demo ids keep the bare `coach-<n>`
  // shape the regression suites assert on.
  const sessionNonceRef = useRef(
    `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
  );
  const nextId = () =>
    accountRef.current.kind === 'real'
      ? `coach-${sessionNonceRef.current}-${++idRef.current}`
      : `coach-${++idRef.current}`;
  // ─── Account persistence bookkeeping (real accounts only) ─────────────
  // Wire signature of every message the account already stores, by id: the
  // persistence effect diffs against it, so a card update or hidden flip
  // re-upserts its row while untouched messages never re-send.
  const persistedRef = useRef(new Map<string, string>());
  // Ids waiting to be appended, in thread order (FIFO outbox).
  const outboxRef = useRef<string[]>([]);
  // Local photo uri → stored per-patient object path, so a photo uploads
  // once even when corrections re-use it or card updates re-upsert its turn.
  const photoPathsRef = useRef(new Map<string, string>());
  // Which accountKey's transcript is on screen. Persistence only runs once
  // hydration for the CURRENT key landed — nothing writes into a transcript
  // that was never read (and demo accounts never hydrate, so nothing ever
  // enqueues for them).
  const hydratedKeyRef = useRef<string | null>(null);
  const flushingRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushFailuresRef = useRef(0);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Coach-initiated outreach. When the patient context says the stall
  // trigger is live (active signals, no opt-out, no engagement for this
  // episode, cooldown respected), the coach opens the conversation — but
  // only while the session's thread is still just the greeting, so it never
  // interrupts an exchange already underway. Seeded as a normal done
  // message: it rides the request history like the greeting, so the model
  // knows exactly what the coach already said. recordNudgeSent anchors the
  // cooldown window on first seed.
  const outreachSeededRef = useRef(false);
  useEffect(() => {
    // Demo persona only: the outreach copy is built from the demo seed's
    // numbers. A real account's proactive outreach is future work.
    if (accountRef.current.resolving || accountRef.current.kind !== 'demo') return;
    if (outreachSeededRef.current || !shouldSeedNudgeOutreach) return;
    if (inFlightRef.current) return;
    if (!messagesRef.current.every(m => m.id === GREETING_MESSAGE_ID)) return;
    outreachSeededRef.current = true;
    const outreach = buildOutreachMessage(nudgeAssessment);
    setMessages(prev =>
      prev.every(m => m.id === GREETING_MESSAGE_ID) ? [...prev, outreach] : prev,
    );
    void recordNudgeSent();
  }, [shouldSeedNudgeOutreach, nudgeAssessment, recordNudgeSent]);

  // Account transitions (sign-in, sign-out, a different patient) drop ALL
  // local chat state: abort any stream, forget suggestions and flows, clear
  // persistence bookkeeping, and reseed the thread for the new owner. The
  // ref-vs-key comparison makes this a no-op on mount, so demo sessions
  // still render their greeting synchronously exactly as before.
  const accountKeyRef = useRef(accountKey);
  useEffect(() => {
    if (accountKeyRef.current === accountKey) return;
    accountKeyRef.current = accountKey;
    abortRef.current?.abort();
    if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
    revealRef.current = null;
    abortRef.current = null;
    inFlightRef.current = false;
    suggestionsRef.current.clear();
    updateLabelFlow(null);
    setPendingStage(null);
    setIsStreaming(false);
    outreachSeededRef.current = false;
    hydratedKeyRef.current = null;
    persistedRef.current.clear();
    outboxRef.current = [];
    photoPathsRef.current.clear();
    flushingRef.current = false;
    flushFailuresRef.current = 0;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const seed = accountKey === 'demo' ? [buildGreetingMessage()] : [];
    messagesRef.current = seed;
    setMessages(seed);
  }, [accountKey, updateLabelFlow]);

  // A provider unmount mid-reveal must not leave a timer mutating state.
  useEffect(() => {
    return () => {
      if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  /**
   * Uploads a turn's photo to the account (once) and returns its stored
   * path, or undefined when there is nothing uploadable — hydrated photos
   * already carry their path, and a failed upload persists the turn without
   * its photo rather than blocking the transcript on image bytes.
   */
  const storedPhotoPath = useCallback(async (m: CoachMessage): Promise<string | undefined> => {
    if (!m.photo) return undefined;
    if (m.photo.path) return m.photo.path;
    const known = photoPathsRef.current.get(m.photo.uri);
    if (known) return known;
    if (!m.photo.uri.startsWith('data:')) return undefined;
    const api = chatApiRef.current;
    if (!api) return undefined;
    const uri = m.photo.uri;
    try {
      const uploaded = await api.uploadChatPhoto(uri);
      photoPathsRef.current.set(uri, uploaded.photoPath);
      // Stamp the path onto every message holding this photo (the origin
      // plus any correction turns that re-used it) so their wire signatures
      // settle on the stored shape.
      setMessages(prev =>
        prev.map(x =>
          x.photo && x.photo.uri === uri && !x.photo.path
            ? { ...x, photo: { ...x.photo, path: uploaded.photoPath } }
            : x,
        ),
      );
      return uploaded.photoPath;
    } catch {
      return undefined; // quiet: the turn persists as its replay text
    }
  }, []);

  /**
   * Serial outbox flush: drains queued ids in thread order, uploading any
   * pending photos first, and appends each wire batch to the account. A
   * failed append requeues the batch and retries on a short timer, parking
   * after repeated failures until the next finalized message (or the next
   * app open) tries again.
   */
  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      while (outboxRef.current.length > 0) {
        const api = chatApiRef.current;
        if (!api) return;
        const batchIds = outboxRef.current.slice(0, 20);
        outboxRef.current = outboxRef.current.slice(batchIds.length);
        const wires: ChatWireMessage[] = [];
        const sigs: Array<[string, string]> = [];
        for (const id of batchIds) {
          const m = messagesRef.current.find(x => x.id === id);
          // Gone (a stopped bubble that kept nothing) or no longer final:
          // nothing to store under this id.
          if (!m || m.status !== 'done') continue;
          const wire = toWireMessage(m, await storedPhotoPath(m));
          wires.push(wire);
          sigs.push([id, JSON.stringify(wire)]);
        }
        if (wires.length === 0) continue;
        try {
          await api.appendChatMessages('coach', wires);
          for (const [id, sig] of sigs) persistedRef.current.set(id, sig);
          flushFailuresRef.current = 0;
        } catch {
          // Requeue in place and back off; the transcript catches up in
          // order once the API is reachable again.
          outboxRef.current = [...batchIds, ...outboxRef.current];
          flushFailuresRef.current += 1;
          if (flushFailuresRef.current < 5 && !flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              void flushOutbox();
            }, 5000);
          }
          return;
        }
      }
    } finally {
      flushingRef.current = false;
    }
    // A message finalized while the drain above was mid-await re-enters
    // here rather than waiting for the next thread change.
    if (outboxRef.current.length > 0 && flushFailuresRef.current === 0) {
      void flushOutbox();
    }
  }, [storedPhotoPath]);

  // Real-account hydration: on open (or account switch) load the stored
  // transcript and resume it. Runs once per accountKey; a failure retries a
  // few times, then leaves the thread empty — sends still work, and the
  // next app open tries again. The greeting seeds ONLY a genuinely new
  // conversation: no stored rows and nothing typed while the load ran.
  useEffect(() => {
    if (!realAccount) return;
    const key = accountKey;
    if (hydratedKeyRef.current === key) return;
    const api = realAccount.api;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const run = async () => {
      let snapshot: ChatThreadSnapshot;
      try {
        snapshot = await api.fetchChatThread('coach', localTodayKey());
      } catch {
        if (cancelled) return;
        attempts += 1;
        if (attempts < 4) retryTimer = setTimeout(() => void run(), 4000);
        return;
      }
      if (cancelled || accountKeyRef.current !== key) return;
      hydratedKeyRef.current = key;
      const stored = snapshot.messages.map(wireToCoachMessage);
      for (const m of stored) {
        // Stored rows are persisted by definition: seed the diff baseline so
        // hydration never re-appends them.
        persistedRef.current.set(m.id, JSON.stringify(toWireMessage(m)));
        if (m.photo?.path) photoPathsRef.current.set(m.photo.uri, m.photo.path);
        // Re-register recipe cards so their preview screens reopen; a stored
        // meal card keeps the patient's own photo as its picture.
        if (m.card?.kind === 'recipe') {
          const suggestion = parseRecipeCardPayload(m.card.payload);
          if (suggestion) {
            const origin = m.replyToId ? stored.find(o => o.id === m.replyToId) : undefined;
            const registered =
              suggestion.mode === 'meal' && origin?.photo?.uri
                ? { ...suggestion, photoUri: origin.photo.uri }
                : suggestion;
            suggestionsRef.current.set(registered.id, registered);
          }
        }
      }
      setMessages(prev => {
        if (stored.length === 0) {
          // First conversation on this account. Anything already typed this
          // session stays; the greeting seeds only a truly untouched thread.
          return prev.length === 0 ? [buildRealGreetingMessage(snapshot.patient)] : prev;
        }
        const storedIds = new Set(stored.map(m => m.id));
        const extras = prev.filter(m => !storedIds.has(m.id));
        return [...stored, ...extras];
      });
    };
    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [realAccount, accountKey]);

  // Persistence: whenever the thread changes, enqueue every finalized
  // message whose wire shape differs from what the account already stores —
  // user turns land at send, assistant replies once the reveal finalizes
  // them (stopped ones included), and later mutations of a stored message
  // (card updates, the hidden flip, a photo path landing) re-upsert its row.
  // Streaming and error bubbles never match `done`, so they never persist.
  useEffect(() => {
    if (!realAccount || hydratedKeyRef.current !== accountKey) return;
    let queued = false;
    for (const m of messages) {
      if (m.status !== 'done') continue;
      const sig = JSON.stringify(
        toWireMessage(m, m.photo ? photoPathsRef.current.get(m.photo.uri) : undefined),
      );
      if (persistedRef.current.get(m.id) === sig) continue;
      if (!outboxRef.current.includes(m.id)) {
        outboxRef.current.push(m.id);
        queued = true;
      }
    }
    if (queued) void flushOutbox();
  }, [messages, realAccount, accountKey, flushOutbox]);

  /**
   * Completes a fully revealed reply: marks it done (trimming whitespace a
   * stripped control marker may have left), attaches the held card and
   * quick-reply suggestion, and unlocks the chat. Runs exactly once per
   * reply — either from the reveal tick that drains the buffer or straight
   * from onDone when nothing was left to reveal.
   */
  const finalizeReveal = useCallback((reveal: RevealState) => {
    if (reveal.timer) {
      clearInterval(reveal.timer);
      reveal.timer = null;
    }
    revealRef.current = null;
    abortRef.current = null;
    const { assistantId, card, quickReplies, labelDraft } = reveal;
    setMessages(current =>
      current.map(m => {
        if (m.id !== assistantId) return m;
        const next: CoachMessage = { ...m, status: 'done', text: m.text.trimEnd() };
        if (card && !next.card) next.card = card;
        if (quickReplies && !next.quickReplies) next.quickReplies = quickReplies;
        return next;
      }),
    );
    // A finished label read opens the name conversation exactly when its
    // ask text is fully on screen.
    if (labelDraft) updateLabelFlow({ phase: 'awaiting-name', draft: labelDraft });
    inFlightRef.current = false;
    setPendingStage(null);
    setIsStreaming(false);
  }, [updateLabelFlow]);

  /**
   * Starts the reveal timer when it is not already running. Each tick moves
   * one paced chunk from the hidden buffer into the visible message text;
   * when the buffer runs dry the timer either finalizes (network already
   * done) or parks until the next delta arrives.
   */
  const ensureRevealTimer = useCallback(
    (reveal: RevealState) => {
      if (reveal.timer) return;
      reveal.timer = setInterval(() => {
        // stop()/error/finalize clear this interval synchronously, but guard
        // anyway: a stray tick must never touch a later exchange.
        if (revealRef.current !== reveal) {
          if (reveal.timer) {
            clearInterval(reveal.timer);
            reveal.timer = null;
          }
          return;
        }
        if (reveal.pending.length === 0) {
          if (reveal.networkDone) {
            finalizeReveal(reveal);
          } else if (reveal.timer) {
            // Idle: the network may still send more. Park until then.
            clearInterval(reveal.timer);
            reveal.timer = null;
          }
          return;
        }
        const chunk = takeRevealChunk(reveal);
        setMessages(current =>
          current.map(m =>
            m.id === reveal.assistantId ? { ...m, text: m.text + chunk } : m,
          ),
        );
      }, REVEAL_TICK_MS);
    },
    [finalizeReveal],
  );

  /**
   * Shared streaming core for send/retry: wires the SSE callbacks to the
   * assistant bubble with the given id. Callers own the single-flight lock,
   * abortRef, and putting the streaming bubble into state first.
   */
  const streamInto = useCallback(
    (
      body: CoachChatRequestBody,
      assistantId: string,
      controller: AbortController,
      /**
       * Set on meal photo turns: the patient's own photo, attached to the
       * arriving meal suggestion so the preview screen shows THEIR plate
       * instead of generating an AI image. Menu turns never produce meal
       * cards, so passing it on every photo turn is safe.
       */
      mealPhotoUri?: string,
      /**
       * Id of the user photo message this exchange answers. When the server
       * triages a kindless photo it announces the resolved route, and the
       * stamp lands here — so a retry of this turn names the route instead
       * of triaging the same photo again (a second triage could pick the
       * other pipeline).
       */
      photoOriginId?: string,
    ) => {
      // Callbacks from a stream the user already stopped must not run: stop()
      // finalized the UI and may even have let a new exchange begin.
      const isStale = () => abortRef.current !== controller;

      // Single-flight leaves no live reveal here; clear defensively anyway so
      // a leaked timer could never race two exchanges.
      if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
      const reveal: RevealState = {
        assistantId,
        pending: '',
        networkDone: false,
        timer: null,
      };
      revealRef.current = reveal;

      // Demo requests stay byte-identical to the session-only design.
      // Signed-in requests authenticate and stamp the device's local
      // calendar day so the server grounds "today" on the same day the
      // app is showing.
      const auth = accountRef.current;
      void streamCoachChat(
        auth.kind === 'demo' ? body : { ...body, localDate: localTodayKey() },
        {
          onDelta: delta => {
            if (isStale()) return;
            // Buffer only — the reveal timer moves text into state at pace.
            reveal.pending += delta;
            ensureRevealTimer(reveal);
          },
          onCard: card => {
            if (isStale()) return;
            if (card.kind === 'recipe') {
              // Defensive re-parse; a malformed payload drops the card rather
              // than crashing the preview screen later.
              const suggestion = parseRecipeCardPayload(card.payload);
              if (!suggestion) return;
              // A meal-from-photo card keeps the patient's own photo as its
              // picture — the preview screen then skips AI image generation.
              const registered =
                suggestion.mode === 'meal' && mealPhotoUri
                  ? { ...suggestion, photoUri: mealPhotoUri }
                  : suggestion;
              suggestionsRef.current.set(registered.id, registered);
            }
            // Held until the reveal finishes (first card wins; the server
            // sends at most one per reply anyway).
            if (!reveal.card) reveal.card = card;
          },
          onQuickReplies: labels => {
            if (isStale()) return;
            // Held like the card; first suggestion wins.
            if (!reveal.quickReplies) reveal.quickReplies = labels;
          },
          onLabelDraft: raw => {
            if (isStale()) return;
            // Validate HERE (not in the API layer) so a malformed draft
            // drops the flow instead of half-opening it. First one wins.
            const draft = parseLabelDraft(raw);
            if (draft && !reveal.labelDraft) reveal.labelDraft = draft;
          },
          onPhotoKind: kind => {
            if (isStale() || !photoOriginId) return;
            // Stamp the server-resolved route onto the photo turn (never
            // overwriting an explicit kind). The replay text is already
            // fixed, so the stamp only affects retries, the retake chip,
            // and the photo bubble's accessibility label.
            setMessages(prev =>
              prev.map(m =>
                m.id === photoOriginId && m.photo && m.photo.kind === undefined
                  ? { ...m, photo: { ...m.photo, kind } }
                  : m,
              ),
            );
          },
          onStage: stage => {
            if (isStale()) return;
            // Narration only: relabels the waiting bubble. Once reply text
            // is on screen the caption is not rendered at all, so a late
            // stage event cannot disturb the reveal.
            setPendingStage(stage);
          },
          onDone: () => {
            if (isStale()) return;
            reveal.networkDone = true;
            // Anything still buffered keeps typing out; the tick that drains
            // the buffer finalizes. Only finalize here when there is nothing
            // left to reveal (idle timer parked or never started).
            if (reveal.pending.length === 0 && reveal.timer === null) {
              finalizeReveal(reveal);
            }
          },
          onError: (message, retryable) => {
            if (isStale()) return;
            // The error replaces the reply wholesale — drop the unrevealed
            // buffer and any held card/quick replies with it.
            if (reveal.timer) {
              clearInterval(reveal.timer);
              reveal.timer = null;
            }
            revealRef.current = null;
            abortRef.current = null;
            setMessages(current =>
              current.map(m =>
                m.id === assistantId ? { ...m, status: 'error', text: message, retryable } : m,
              ),
            );
            inFlightRef.current = false;
            setPendingStage(null);
            setIsStreaming(false);
          },
        },
        auth.kind === 'demo'
          ? { signal: controller.signal }
          : {
              signal: controller.signal,
              // Real (and still-unresolved) accounts authenticate: the
              // server grounds the coach on the account's own data. A
              // missing token surfaces as an honest error bubble — never a
              // silent demo fallback.
              getAuthToken: auth.getAccessToken ?? (async () => null),
            },
      );
    },
    [ensureRevealTimer, finalizeReveal],
  );

  /**
   * Advances the label flow with the patient's text: proposes a Title Case
   * name, reads a confirm chip (or a typed correction), or applies a
   * rename. Entirely client-side — the assistant bubbles here are fixed
   * strings in the coach voice, appended as already-done messages, and no
   * request leaves the device.
   */
  const resolveLabelFlowText = useCallback(
    (flow: LabelFlowState, text: string) => {
      const userMessage: CoachMessage = { id: nextId(), role: 'user', text, status: 'done' };
      const reply = (replyText: string, extras?: Partial<CoachMessage>): CoachMessage => ({
        id: nextId(),
        role: 'assistant',
        text: replyText,
        status: 'done',
        replyToId: userMessage.id,
        ...extras,
      });

      if (flow.phase === 'awaiting-name') {
        const name = toTitleCase(text);
        updateLabelFlow({ phase: 'confirming', draft: flow.draft, name });
        setMessages(prev => [
          ...prev,
          userMessage,
          reply(labelConfirmText(name), {
            quickReplies: [LABEL_CONFIRM_CREATE, LABEL_CONFIRM_FIX],
          }),
        ]);
        return;
      }

      if (flow.phase === 'confirming') {
        if (text === LABEL_CONFIRM_FIX) {
          updateLabelFlow({ phase: 'awaiting-name', draft: flow.draft });
          setMessages(prev => [...prev, userMessage, reply(LABEL_RENAME_ASK)]);
          return;
        }
        if (text === LABEL_CONFIRM_CREATE && flow.name) {
          // The card payload is the held server draft plus the confirmed
          // name — the name never round-tripped through the model.
          const payload: LabelFoodCardPayload = { ...flow.draft, name: flow.name };
          updateLabelFlow(null);
          setMessages(prev => [
            ...prev,
            userMessage,
            reply(LABEL_CARD_INTRO, { card: { kind: 'food', payload } }),
          ]);
          return;
        }
        // Anything else typed here is a corrected name — reconfirm with it.
        const name = toTitleCase(text);
        updateLabelFlow({ phase: 'confirming', draft: flow.draft, name });
        setMessages(prev => [
          ...prev,
          userMessage,
          reply(labelConfirmText(name), {
            quickReplies: [LABEL_CONFIRM_CREATE, LABEL_CONFIRM_FIX],
          }),
        ]);
        return;
      }

      // renaming: the text is the new name for the existing food card.
      const { cardMessageId } = flow;
      const name = toTitleCase(text);
      updateLabelFlow(null);
      setMessages(prev => [
        ...prev.map(m =>
          m.id === cardMessageId && m.card?.kind === 'food'
            ? {
                ...m,
                card: {
                  kind: 'food',
                  payload: { ...(m.card.payload as LabelFoodCardPayload), name },
                },
              }
            : m,
        ),
        userMessage,
        reply(labelRenamedAck(name)),
      ]);
    },
    [updateLabelFlow],
  );

  const send = useCallback(
    (rawText: string) => {
      const text = rawText.trim();
      if (!text || inFlightRef.current) return;
      // While a signed-in account is still resolving, hold sends: the thread
      // is about to be reseeded for its owner, and a turn fired now would
      // ground on the wrong patient and then vanish in the reset.
      if (accountRef.current.resolving) return;
      // An active label flow answers this text client-side — the name
      // conversation is deterministic state, never a model exchange.
      const flow = labelFlowRef.current;
      if (flow) {
        resolveLabelFlowText(flow, text);
        return;
      }

      // Any reply while the outreach is in the thread counts as engagement:
      // the proactive conversation stops re-opening once the patient has
      // answered in any form (fire-and-forget; the guard is idempotent).
      if (messagesRef.current.some(m => m.id === OUTREACH_MESSAGE_ID)) {
        void markNudgeEngaged();
      }

      // The outreach's decline chip and its follow-up resolve client-side,
      // like the label flow: fixed coach strings, no model call. Anything
      // typed instead of the exact chip labels falls through to the coach.
      const latestMessage = messagesRef.current[messagesRef.current.length - 1];
      if (latestMessage?.id === OUTREACH_MESSAGE_ID && text === OUTREACH_DECLINE) {
        const userMessage: CoachMessage = { id: nextId(), role: 'user', text, status: 'done' };
        setMessages(prev => [
          ...prev,
          userMessage,
          {
            id: nextId(),
            role: 'assistant',
            text: NUDGE_DECLINE_ASK,
            status: 'done',
            replyToId: userMessage.id,
            quickReplies: [NUDGE_KEEP_WATCH, NUDGE_PAUSE],
          },
        ]);
        return;
      }
      if (
        latestMessage?.role === 'assistant' &&
        latestMessage.text === NUDGE_DECLINE_ASK &&
        (text === NUDGE_KEEP_WATCH || text === NUDGE_PAUSE)
      ) {
        if (text === NUDGE_PAUSE) void setNudgeOptOut(true);
        const userMessage: CoachMessage = { id: nextId(), role: 'user', text, status: 'done' };
        setMessages(prev => [
          ...prev,
          userMessage,
          {
            id: nextId(),
            role: 'assistant',
            text: text === NUDGE_PAUSE ? NUDGE_PAUSE_ACK : NUDGE_KEEP_ACK,
            status: 'done',
            replyToId: userMessage.id,
          },
        ]);
        return;
      }

      // A typed fix right under a meal-card reply re-runs the SAME held
      // photo with the patient's words as ground truth — no retake. Both
      // gates must agree: the adjacency (a finished meal-card reply whose
      // photo is still in state) and the text reading as a correction.
      // Anything else falls through to the normal chat turn below, so an
      // unrelated question after a meal card still gets a normal answer.
      // Only a photo still held as local bytes can be re-attached: a turn
      // hydrated from the account carries a display URL, and the server
      // takes data URIs only — such a fix falls through to a normal text
      // turn instead of failing on the photo.
      const correctionPhoto = findMealCorrectionOrigin(messagesRef.current)?.photo;
      if (correctionPhoto && isLocalPhotoUri(correctionPhoto.uri) && isMealCorrectionText(text)) {
        inFlightRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;

        // The bubble shows the typed words; the re-used photo rides along
        // invisibly (reused) so retries re-attach it and the retake chip
        // still works under the corrected reply. The pinned slot carries
        // over — the fix renames the foods, not the diary slot.
        const userMessage: CoachMessage = {
          id: nextId(),
          role: 'user',
          text,
          status: 'done',
          photo: { ...correctionPhoto, kind: 'meal', reused: true },
        };
        const assistantId = nextId();

        const request: CoachRequestMessage[] = [...messagesRef.current, userMessage]
          .filter(m => m.status === 'done' && m.text.length > 0)
          .slice(-MAX_REQUEST_MESSAGES)
          .map(toRequestMessage);
        // The correction is the request tail: the typed text stays the
        // content (the server's detector reads it there) and the held photo
        // is re-attached with its kind, so the meal pipeline answers without
        // re-triaging.
        request[request.length - 1] = {
          ...request[request.length - 1],
          image: correctionPhoto.uri,
          photoKind: 'meal',
        };

        setIsStreaming(true);
        // The re-attached photo makes this a photo turn: acknowledge it
        // locally before the stream even opens.
        setPendingStage('received');
        setMessages(prev => [
          ...prev,
          userMessage,
          {
            id: assistantId,
            role: 'assistant',
            text: '',
            status: 'streaming',
            replyToId: userMessage.id,
          },
        ]);

        streamInto(
          {
            messages: request,
            localTime: localTimeForDate(clock()),
            ...(correctionPhoto.mealSlot ? { mealSlot: correctionPhoto.mealSlot } : {}),
          },
          assistantId,
          controller,
          // The rebuilt card keeps the patient's own plate as its picture.
          correctionPhoto.uri,
        );
        return;
      }

      inFlightRef.current = true;

      const controller = new AbortController();
      abortRef.current = controller;

      const userMessage: CoachMessage = { id: nextId(), role: 'user', text, status: 'done' };
      const assistantId = nextId();

      // Build the request from a stable snapshot BEFORE touching state, so the
      // network call never runs inside a state updater (updaters must stay pure
      // and may be replayed by React).
      const request: CoachRequestMessage[] = [...messagesRef.current, userMessage]
        .filter(m => m.status === 'done' && m.text.length > 0)
        .slice(-MAX_REQUEST_MESSAGES)
        .map(toRequestMessage);

      setIsStreaming(true);
      // Text turns carry no narration; clear any leftover from a photo turn.
      setPendingStage(null);
      setMessages(prev => [
        ...prev,
        userMessage,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          status: 'streaming',
          replyToId: userMessage.id,
        },
      ]);

      // The clock is read at send time so every turn carries a fresh reading.
      streamInto(
        { messages: request, localTime: localTimeForDate(clock()) },
        assistantId,
        controller,
      );
    },
    [streamInto, clock, resolveLabelFlowText, markNudgeEngaged, setNudgeOptOut],
  );

  const sendPhoto = useCallback(
    (
      photo: { uri: string; width: number; height: number },
      kind?: PhotoKind,
      options?: SendPhotoOptions,
    ) => {
      if (!photo.uri || inFlightRef.current) return;
      if (accountRef.current.resolving) return;
      // A photo reply counts as engagement exactly like a text reply.
      if (messagesRef.current.some(m => m.id === OUTREACH_MESSAGE_ID)) {
        void markNudgeEngaged();
      }
      inFlightRef.current = true;
      // A fresh photo abandons any pending label conversation: the held
      // draft belongs to the previous photo, not this one.
      updateLabelFlow(null);

      const controller = new AbortController();
      abortRef.current = controller;

      // The visible bubble is the photo; the fixed text is what this turn
      // reads as when the thread is replayed on later requests.
      const userMessage: CoachMessage = {
        id: nextId(),
        role: 'user',
        text:
          kind === 'meal'
            ? MEAL_PHOTO_MESSAGE_TEXT
            : kind === 'menu'
              ? MENU_PHOTO_MESSAGE_TEXT
              : kind === 'label'
                ? LABEL_PHOTO_MESSAGE_TEXT
                : PHOTO_MESSAGE_TEXT,
        status: 'done',
        photo: {
          ...photo,
          ...(kind ? { kind } : {}),
          // Kept on the message so a retry re-sends the same pinned slot.
          ...(options?.mealSlot ? { mealSlot: options.mealSlot } : {}),
        },
      };
      const assistantId = nextId();

      // Same snapshot rule as send(). The photo (and its pipeline flag, when
      // the capture flow knows one) ride ONLY the request tail:
      // toRequestMessage keeps every replayed message text-only, so a photo
      // is never uploaded twice. A kindless tail lets the server look at the
      // photo and route it itself.
      const request: CoachRequestMessage[] = [...messagesRef.current, userMessage]
        .filter(m => m.status === 'done' && m.text.length > 0)
        .slice(-MAX_REQUEST_MESSAGES)
        .map(toRequestMessage);
      request[request.length - 1] = {
        ...request[request.length - 1],
        image: photo.uri,
        ...(kind ? { photoKind: kind } : {}),
      };

      setIsStreaming(true);
      // Instant acknowledgment: the waiting bubble says the photo arrived
      // before the request has even left the device. The server repeats the
      // same stage as its first event, so a slow connection changes nothing.
      setPendingStage('received');
      setMessages(prev => {
        // A photo-opened session starts with the photo, not the canned
        // hello: when nothing but the seeded greeting is on screen yet, hide
        // it. It stays in the request history above, so the model still
        // knows the patient was greeted.
        const opensThread = prev.every(m => m.id === GREETING_MESSAGE_ID);
        const base = opensThread
          ? prev.map(m => (m.id === GREETING_MESSAGE_ID ? { ...m, hidden: true } : m))
          : prev;
        return [
          ...base,
          userMessage,
          {
            id: assistantId,
            role: 'assistant',
            text: '',
            status: 'streaming',
            replyToId: userMessage.id,
          },
        ];
      });

      // Menu turns never produce meal cards, so passing the photo along on
      // every non-menu turn is safe — and a kindless turn the server routes
      // to the meal pipeline then keeps the patient's own plate as the
      // card's picture.
      streamInto(
        {
          messages: request,
          localTime: localTimeForDate(clock()),
          // An entry point that already knows its diary slot pins it here;
          // the server then overrides both a named meal and the clock.
          ...(options?.mealSlot ? { mealSlot: options.mealSlot } : {}),
        },
        assistantId,
        controller,
        kind === 'menu' ? undefined : photo.uri,
        // Lets the server's route announcement stamp this turn for retries.
        userMessage.id,
      );
    },
    [streamInto, clock, updateLabelFlow, markNudgeEngaged],
  );

  const retry = useCallback(
    (assistantMessageId: string) => {
      if (inFlightRef.current) return;
      if (accountRef.current.resolving) return;
      const history = messagesRef.current;
      const errored = history.find(m => m.id === assistantMessageId);
      if (
        !errored ||
        errored.role !== 'assistant' ||
        errored.status !== 'error' ||
        !errored.replyToId
      ) {
        return;
      }
      const originIndex = history.findIndex(m => m.id === errored.replyToId);
      if (originIndex === -1) return;

      // Rebuild the request exactly as the failed send did: the thread as it
      // stood up to and including the originating user message. Anything the
      // patient asked after the failure stays out of this exchange.
      const request: CoachRequestMessage[] = history
        .slice(0, originIndex + 1)
        .filter(m => m.status === 'done' && m.text.length > 0)
        .slice(-MAX_REQUEST_MESSAGES)
        .map(toRequestMessage);
      // The origin is a done, non-empty user message, so it is the request
      // tail by construction; bail rather than send a malformed request.
      if (request.length === 0 || request[request.length - 1].role !== 'user') return;
      // A failed photo turn retries with its photo: the origin user message
      // is the request tail (checked above), so re-attach the image there —
      // the photo stayed in client state, no re-take needed. The kind rides
      // along so the retry reaches the same pipeline (meal analysis vs menu
      // scan) as the original send.
      const origin = history[originIndex];
      // Only session-local captures can re-attach (hydrated turns hold a
      // display URL — and error bubbles are never persisted, so in practice
      // a retryable origin always still has its local capture).
      if (origin.photo && isLocalPhotoUri(origin.photo.uri)) {
        request[request.length - 1] = {
          ...request[request.length - 1],
          image: origin.photo.uri,
          ...(origin.photo.kind ? { photoKind: origin.photo.kind } : {}),
        };
      }

      inFlightRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      const assistantId = nextId();

      setIsStreaming(true);
      // A photo retry is a photo turn again: acknowledge immediately. Text
      // retries clear any stale narration instead.
      setPendingStage(origin.photo ? 'received' : null);
      // Swap the error bubble for a fresh streaming bubble in place; it keeps
      // pointing at the same user message so a failed retry can retry again.
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMessageId
            ? {
                id: assistantId,
                role: 'assistant' as const,
                text: '',
                status: 'streaming' as const,
                replyToId: errored.replyToId,
              }
            : m,
        ),
      );

      streamInto(
        {
          messages: request,
          // A fresh clock reading, not the original send's: the retry is
          // happening NOW, and that is the time a logged meal belongs to.
          localTime: localTimeForDate(clock()),
          ...(origin.photo?.mealSlot ? { mealSlot: origin.photo.mealSlot } : {}),
        },
        assistantId,
        controller,
        origin.photo && origin.photo.kind !== 'menu' ? origin.photo.uri : undefined,
        // Stamp target: a kindless retry pins the announced route.
        origin.photo ? origin.id : undefined,
      );
    },
    [streamInto, clock],
  );

  const stop = useCallback(() => {
    if (!inFlightRef.current) return;
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    // The reveal stops with the stream: anything still buffered was never on
    // screen, so it is discarded — the patient keeps exactly what they saw.
    const reveal = revealRef.current;
    if (reveal?.timer) {
      clearInterval(reveal.timer);
      reveal.timer = null;
    }
    revealRef.current = null;
    const heldCard = reveal?.card;
    const heldQuickReplies = reveal?.quickReplies;
    const heldLabelDraft = reveal?.labelDraft;
    // A held label read survives the stop like a card does — but only when
    // the reply bubble itself is kept (the patient saw at least part of the
    // read). A dropped bubble means nothing was shown, so opening the name
    // conversation would have the coach reference an answer that never
    // appeared.
    if (heldLabelDraft) {
      const streaming = messagesRef.current.find(m => m.status === 'streaming');
      const keepsBubble =
        streaming !== undefined &&
        (streaming.text.trimEnd().length > 0 || Boolean(streaming.card ?? heldCard));
      if (keepsBubble) updateLabelFlow({ phase: 'awaiting-name', draft: heldLabelDraft });
    }
    // Finalize locally — the aborted stream stays silent (no onDone/onError).
    // Single-flight means at most one message is mid-stream: keep its partial
    // text as a finished reply flagged `stopped` (so the next request marks
    // it interrupted), or drop the bubble if nothing was shown yet and no
    // card arrived. A card the server already sent survives the stop.
    setMessages(current =>
      current.flatMap(m => {
        if (m.status !== 'streaming') return [m];
        const text = m.text.trimEnd();
        const card = m.card ?? heldCard;
        if (text.length === 0 && !card) return [];
        const kept: CoachMessage = { ...m, status: 'done' as const, text, stopped: true };
        if (card) kept.card = card;
        if (!kept.quickReplies && heldQuickReplies) kept.quickReplies = heldQuickReplies;
        return [kept];
      }),
    );
    inFlightRef.current = false;
    setPendingStage(null);
    setIsStreaming(false);
  }, [updateLabelFlow]);

  const getRecipeSuggestion = useCallback(
    (id: string) => suggestionsRef.current.get(id),
    [],
  );

  const beginLabelRename = useCallback(
    (cardMessageId: string) => {
      // Renames ride the label flow's send() interception, so they cannot
      // start while a real exchange is in flight.
      if (inFlightRef.current) return;
      const message = messagesRef.current.find(m => m.id === cardMessageId);
      if (!message || message.card?.kind !== 'food') return;
      const payload = message.card.payload as LabelFoodCardPayload;
      // An added card is frozen: the food is saved, so renames happen in
      // the library's edit screen like any other custom food.
      if (payload.added) return;
      // The payload is a superset of the draft; re-parse rather than trust.
      const draft = parseLabelDraft(payload);
      if (!draft) return;
      updateLabelFlow({ phase: 'renaming', draft, cardMessageId });
    },
    [updateLabelFlow],
  );

  const markLabelFoodAdded = useCallback(
    (cardMessageId: string, slot: MealSlot, quantity: number = 1) => {
      // Adding while a rename waits on this card ends the rename: the food
      // is saved now, so later text must reach the coach, not the card.
      if (labelFlowRef.current?.cardMessageId === cardMessageId) updateLabelFlow(null);
      setMessages(prev =>
        prev.map(m =>
          m.id === cardMessageId && m.card?.kind === 'food'
            ? {
                ...m,
                card: {
                  kind: 'food',
                  payload: {
                    ...(m.card.payload as LabelFoodCardPayload),
                    added: true,
                    addedSlot: slot,
                    // Entry-only multiplier, echoed by the frozen
                    // confirmation. The saved food stays per-serving.
                    addedQuantity: quantity,
                  },
                },
              }
            : m,
        ),
      );
    },
    [updateLabelFlow],
  );

  const setSuggestionPhoto = useCallback((id: string, photoUri: string) => {
    const suggestion = suggestionsRef.current.get(id);
    if (suggestion) suggestionsRef.current.set(id, { ...suggestion, photoUri });
  }, []);

  const clearLocalState = useCallback(() => {
    abortRef.current?.abort();
    if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
    revealRef.current = null;
    abortRef.current = null;
    inFlightRef.current = false;
    suggestionsRef.current.clear();
    updateLabelFlow(null);
    setPendingStage(null);
    setIsStreaming(false);
    // Drop persistence bookkeeping with the thread. Anything still queued
    // is abandoned deliberately: this runs on sign-out, and the next open
    // hydrates whatever HAD landed on the account.
    hydratedKeyRef.current = null;
    persistedRef.current.clear();
    outboxRef.current = [];
    photoPathsRef.current.clear();
    flushingRef.current = false;
    flushFailuresRef.current = 0;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const seed =
      !accountRef.current.resolving && accountRef.current.kind === 'demo'
        ? [buildGreetingMessage()]
        : [];
    messagesRef.current = seed;
    setMessages(seed);
  }, [updateLabelFlow]);

  const value = useMemo(
    () => ({
      messages,
      isStreaming,
      pendingStage,
      send,
      sendPhoto,
      retry,
      stop,
      getRecipeSuggestion,
      setSuggestionPhoto,
      labelFlow,
      beginLabelRename,
      markLabelFoodAdded,
      clearLocalState,
    }),
    [
      messages,
      isStreaming,
      pendingStage,
      send,
      sendPhoto,
      retry,
      stop,
      getRecipeSuggestion,
      setSuggestionPhoto,
      labelFlow,
      beginLabelRename,
      markLabelFoodAdded,
      clearLocalState,
    ],
  );

  return <CoachChatContext.Provider value={value}>{children}</CoachChatContext.Provider>;
}

export function useCoachChat(): CoachChatContextValue {
  const context = useContext(CoachChatContext);
  if (!context) throw new Error('useCoachChat must be used within CoachChatProvider');
  return context;
}
