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
import { AppState } from 'react-native';
import { usePatient } from '@/context/PatientContext';
import { coachDietContextFor, type CoachDietContext } from '@/lib/diet-state';
import { COACH_TITLE_MAX_CHARS, DEFAULT_COACH_TITLE, cleanCoachTitle, demoCoachTitleFromMessage } from '@/lib/coach-title';
import {
  usePatientAccount,
  type CoachConversation,
  type CoachConversationPage,
  type ChatWireMessage,
  type PatientDataApi,
} from '@/context/PatientAccountContext';
import { ENROLLMENT_DAYS, PATIENT_PROFILE, type MealSlot } from '@/data/patient-data';
import { localTodayKey } from '@/lib/live-patient-entry';
import { BACK_ON_TRACK_OFFER, isOutreachMessageId, type NudgeAssessment } from '@/data/stall-nudge';
import {
  fetchCoachAvailability,
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
import { subscribeChatSync } from '@/lib/chat-sync-events';

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
  /** Server transcript order/timestamp are retained when historical pages load. */
  seq?: number;
  createdAt?: string;

  role: 'user' | 'assistant' | 'staff';

  /** Human-readable care-team sender, present only on server-owned staff rows. */
  senderLabel?: string;

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

export interface CoachChatContextValue {
  messages: CoachMessage[];
  isStreaming: boolean;
  /** Null represents a fresh composer which has not created a server row yet. */
  selectedConversation: CoachConversation | null;
  /** Changes for every account/conversation selection; reset local UI by it. */
  conversationScopeKey: string | null;
  /**
   * Changes whenever the signed-in owner is replaced or local access is
   * revoked. History uses it to ensure a page cached for a former account is
   * never rendered for the next account.
   */
  historyScopeKey: string | null;
  conversationError: string | null;
  /** Account-level Coach denial (401/403); history must stop auto-loading until Retry. */
  accessDeniedError: string | null;
  /** True only while no transcript is available for the selected destination. */
  isConversationLoading: boolean;
  /** True while an already-visible transcript is being refreshed. */
  isConversationRefreshing: boolean;
  /** True when the current destination has a locally available transcript. */
  hasConversationLoaded: boolean;
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  startNewConversation: () => void;
  selectConversation: (id: string) => Promise<void>;
  /**
   * Returns a page immediately, if this account epoch has one. Callers may
   * render stale rows while listConversations refreshes them in background.
   */
  getCachedConversations: (archived: boolean, offset?: number) => CoachConversationPage | undefined;
  /**
   * Fresh cached pages resolve without a transport request; stale pages are
   * refreshed and simultaneous requests for the same page share one promise.
   * `force` bypasses the freshness TTL but still coalesces in-flight work.
   */
  listConversations: (
    archived: boolean,
    offset?: number,
    force?: boolean,
  ) => Promise<CoachConversationPage>;
  setArchived: (conversation: CoachConversation, archived: boolean) => Promise<void>;
  /** Renames one conversation (patient's choice wins over the server's generated name). */
  renameConversation: (conversation: CoachConversation, title: string) => Promise<CoachConversation>;
  loadOlder: () => Promise<void>;
  /**
   * Progress narration for the in-flight photo turn (null on text turns and
   * between exchanges). Set to "received" the instant a photo send starts —
   * the acknowledgment must not wait on the network — then upgraded by the
   * server's stage events once the pipeline is known; cleared on finalize,
   * error, and stop. The chat screen captions the waiting bubble with it
   * while no reply text is on screen yet.
   */
  pendingStage: CoachStage | null;
  /**
   * Re-fetches server-owned transcript rows for the selected conversation.
   * `force` bypasses the freshness TTL (use for an explicit Retry or sync
   * event); it never hides a cached transcript while the request is pending.
   */
  refreshThread: (force?: boolean) => Promise<void>;
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
  /**
   * Set while the care team has the coach switched off for every patient
   * (an HQ policy read from the server — never inferred locally). Carries
   * the server's own patient-facing explanation. Only real accounts can be
   * paused; the demo persona always chats. While set, send/sendPhoto are
   * no-ops and the screen closes the composer with the paused notice.
   */
  coachPaused: { message: string } | null;
}

const CoachChatContext = createContext<CoachChatContextValue | null>(null);

/** Used only if the server pauses the coach without its own wording. */
const COACH_PAUSED_FALLBACK =
  'Your coach is paused by your care team right now. Your diary and progress still work as usual.';

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

/** Captured before async persistence so a later selection cannot retarget it. */
interface CoachOutboxEntry {
  scopeKey: string;
  conversationId: string;
  api: PatientDataApi;
  message: CoachMessage;
}

interface CachedConversation {
  conversation: CoachConversation;
  messages: CoachMessage[];
  nextBefore: number | null;
  fetchedAt: number;
  /** Only these ids were confirmed by a successful transcript read. */
  serverMessageIds: Set<string>;
}

interface CachedConversationPage {
  page: CoachConversationPage;
  fetchedAt: number;
}

/** A short TTL prevents focus churn while still making ordinary returns fresh. */
export const COACH_CONVERSATION_CACHE_TTL_MS = 15_000;
export const COACH_READ_STALE = 'COACH_READ_STALE';

function staleCoachReadError(): Error & { code: typeof COACH_READ_STALE } {
  return Object.assign(new Error('This Coach read belongs to an earlier account session.'), {
    code: COACH_READ_STALE,
  } as const);
}

function isTerminalConversationAccessError(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  return status === 401 || status === 403 || status === 404;
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
/** A new conversation never summarizes or replays a prior conversation. */
function buildFreshGreetingMessage(): CoachMessage {
  return {
    id: GREETING_MESSAGE_ID,
    role: 'assistant',
    status: 'done',
    text: 'Hi. What would you like help with today?',
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
  if (m.seq !== undefined) wire.seq = m.seq;
  if (m.createdAt) wire.createdAt = m.createdAt;
  if (m.role === 'staff' && m.senderLabel) wire.senderLabel = m.senderLabel;
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
  if (w.seq !== undefined) m.seq = w.seq;
  if (w.createdAt) m.createdAt = w.createdAt;
  if (w.role === 'staff' && w.senderLabel) m.senderLabel = w.senderLabel;
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
    diet,
    dietStatus,
  } = usePatient();
  // Diet + food preference lists ride along on signed-in turns so recipes
  // and meal ideas honor them. Read through a ref: a list edit mid-stream
  // must not re-create the send callbacks.
  const dietContextRef = useRef<CoachDietContext | null>(null);
  dietContextRef.current = dietStatus === 'live' ? coachDietContextFor(diet) : null;
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
  // A fresh composer intentionally has no server conversation yet. Its row is
  // created only by the first substantive send/photo, never by navigation.
  const [selectedConversation, setSelectedConversation] = useState<CoachConversation | null>(null);
  const selectedConversationRef = useRef<CoachConversation | null>(null);
  selectedConversationRef.current = selectedConversation;
  // Selection identity lands before the transcript request. This makes the
  // destination scope observable synchronously and prevents a cold selection
  // from accidentally creating/sending into a fresh conversation.
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const pendingConversationIdRef = useRef<string | null>(null);
  pendingConversationIdRef.current = pendingConversationId;
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [accessDeniedError, setAccessDeniedError] = useState<string | null>(null);
  const [isConversationLoading, setIsConversationLoading] = useState(false);
  const [isConversationRefreshing, setIsConversationRefreshing] = useState(false);
  const [loadedConversationScopeKey, setLoadedConversationScopeKey] = useState<string | null>(null);
  const [olderBefore, setOlderBefore] = useState<number | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // Pagination may outlive a focus refresh. The ref is set synchronously so
  // refreshThread never replaces the transcript/epoch underneath its request.
  const isLoadingOlderRef = useRef(false);
  const demoConversationsRef = useRef<CoachConversation[]>([]);
  /** Demo conversations the patient named by hand; auto-naming leaves these alone. */
  const demoRenamedRef = useRef(new Set<string>());
  /**
   * Conversation rows the server has confirmed for a rename/archive, keyed by
   * id. A list or detail read that started BEFORE the write can land after
   * it; instead of letting that older snapshot repaint (and re-cache) the
   * previous title or resurrect an archived row, late reads are reconciled
   * against the newest committed version here.
   */
  const committedConversationsRef = useRef(new Map<string, CoachConversation>());
  const reconcileConversation = useCallback((row: CoachConversation): CoachConversation => {
    const committed = committedConversationsRef.current.get(row.id);
    return committed && committed.version > row.version ? committed : row;
  }, []);
  const demoConversationCounterRef = useRef(0);
  const scopeEpochRef = useRef(0);
  // Account epochs deliberately do not reuse a cache after sign-out/revoke,
  // even if the same patient signs back in during this provider's lifetime.
  const accountEpochRef = useRef(0);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const historyScopeKey =
    !resolving && account.kind !== 'unresolved'
      ? `${accountKey}:epoch-${accountEpoch}`
      : null;
  const historyScopeKeyRef = useRef<string | null>(historyScopeKey);
  historyScopeKeyRef.current = historyScopeKey;
  const conversationCacheRef = useRef(new Map<string, CachedConversation>());
  const conversationRequestsRef = useRef(new Map<string, Promise<CachedConversation>>());
  const historyCacheRef = useRef(new Map<string, CachedConversationPage>());
  const historyRequestsRef = useRef(new Map<string, Promise<CoachConversationPage>>());
  // Separates request validity from the public account epoch: revocation must
  // invalidate held writes without changing historyScopeKey and remounting a
  // history screen into an automatic 401/403 retry loop.
  const cacheGenerationRef = useRef(0);
  const selectionRequestRef = useRef(0);
  // Public/UI scope is epoch-qualified. A sign-out followed by the same
  // account returning must still reset route-local draft/focus state.
  const conversationScopeKey = historyScopeKey
    ? `${historyScopeKey}:${selectedConversation?.id ?? pendingConversationId ?? 'fresh'}`
    : null;
  const scopeKeyRef = useRef<string | null>(conversationScopeKey);
  scopeKeyRef.current = conversationScopeKey;
  // A render after account replacement must not briefly disclose the prior
  // patient's transcript while effects are still being scheduled.
  const [renderedScopeKey, setRenderedScopeKey] = useState(conversationScopeKey);
  // Lazy initializer: the demo greeting is built once per provider mount —
  // one session, one conversation. Real (and still-resolving) accounts start
  // empty instead: their opener comes from the stored transcript, or is
  // seeded only when the account has none (see the hydration effect).
  const [messages, setMessages] = useState<CoachMessage[]>(() =>
    !resolving && account.kind === 'demo' ? [buildGreetingMessage()] : [],
  );
  const [isStreaming, setIsStreaming] = useState(false);
  // HQ coach-availability policy for this account. Two sources, both the
  // server: the availability probe on open/account switch (so the notice
  // shows before the first send) and a 503 `coachPaused` answer on a send
  // (the authority — a stale probe can never let a paused turn through).
  const [coachPaused, setCoachPaused] = useState<{ message: string } | null>(null);
  const coachPausedRef = useRef<{ message: string } | null>(null);
  coachPausedRef.current = coachPaused;
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
  /** Terminal account denial is a revocation boundary, not a retryable row error. */
  const revokeConversationAccess = useCallback((message: string) => {
    flushGenerationRef.current += 1;
    scopeEpochRef.current += 1;
    selectionRequestRef.current += 1;
    cacheGenerationRef.current += 1;
    const deniedId = pendingConversationIdRef.current ?? selectedConversationRef.current?.id;
    abortRef.current?.abort();
    if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
    revealRef.current = null;
    abortRef.current = null;
    inFlightRef.current = false;
    conversationCacheRef.current.clear();
    conversationRequestsRef.current.clear();
    historyCacheRef.current.clear();
    committedConversationsRef.current.clear();
    historyRequestsRef.current.clear();
    outboxRef.current = [];
    persistedRef.current.clear();
    photoPathsRef.current.clear();
    hydratedKeyRef.current = null;
    flushingRef.current = false;
    flushFailuresRef.current = 0;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    suggestionsRef.current.clear();
    updateLabelFlow(null);
    selectedConversationRef.current = null;
    pendingConversationIdRef.current = deniedId ?? null;
    scopeKeyRef.current =
      deniedId
        ? `${accountKeyRef.current}:epoch-${accountEpochRef.current}:${deniedId}`
        : accountKeyRef.current === 'demo'
          ? `demo:epoch-${accountEpochRef.current}:fresh`
          : `${accountKeyRef.current}:epoch-${accountEpochRef.current}:fresh`;
    messagesRef.current = [];
    setSelectedConversation(null);
    setPendingConversationId(deniedId ?? null);
    setMessages([]);
    setRenderedScopeKey(scopeKeyRef.current);
    setLoadedConversationScopeKey(null);
    setOlderBefore(null);
    isLoadingOlderRef.current = false;
    setIsLoadingOlder(false);
    setIsConversationLoading(false);
    setIsConversationRefreshing(false);
    setIsStreaming(false);
    setPendingStage(null);
    setConversationError(message);
    setAccessDeniedError(message);
  }, [updateLabelFlow]);
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
  // Captured target/message pairs waiting to be appended. Never look up the
  // current conversation after an await: selection may have changed.
  const outboxRef = useRef<CoachOutboxEntry[]>([]);
  // Local photo uri → stored per-patient object path, so a photo uploads
  // once even when corrections re-use it or card updates re-upsert its turn.
  const photoPathsRef = useRef(new Map<string, string>());
  // Which accountKey's transcript is on screen. Persistence only runs once
  // hydration for the CURRENT key landed — nothing writes into a transcript
  // that was never read (and demo accounts never hydrate, so nothing ever
  // enqueues for them).
  const hydratedKeyRef = useRef<string | null>(null);
  const flushingRef = useRef(false);
  const flushGenerationRef = useRef(0);
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
    // A drain from the former account may still settle, but must not retain
    // the current account's flush mutex or consume its pending writes.
    flushGenerationRef.current += 1;
    scopeEpochRef.current += 1;
    selectionRequestRef.current += 1;
    cacheGenerationRef.current += 1;
    accountEpochRef.current += 1;
    setAccountEpoch(accountEpochRef.current);
    conversationCacheRef.current.clear();
    conversationRequestsRef.current.clear();
    historyCacheRef.current.clear();
    committedConversationsRef.current.clear();
    historyRequestsRef.current.clear();
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
    selectedConversationRef.current = null;
    pendingConversationIdRef.current = null;
    scopeKeyRef.current =
      accountKey === 'resolving' || accountKey === 'unresolved'
        ? null
        : `${accountKey}:epoch-${accountEpochRef.current}:fresh`;
    setSelectedConversation(null);
    setPendingConversationId(null);
    setConversationError(null);
    setAccessDeniedError(null);
    setOlderBefore(null);
    setIsConversationLoading(false);
    setIsConversationRefreshing(false);
    setLoadedConversationScopeKey(null);
    setIsLoadingOlder(false);
    const seed = accountKey === 'demo' ? [buildGreetingMessage()] : [];
    messagesRef.current = seed;
    setMessages(seed);
    setRenderedScopeKey(scopeKeyRef.current);
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
  const storedPhotoPath = useCallback(async (
    m: CoachMessage,
    api: PatientDataApi,
    scopeKey: string,
    accessToken: string,
    conversationId: string,
  ): Promise<string | undefined> => {
    if (!m.photo) return undefined;
    if (m.photo.path) return m.photo.path;
    const known = photoPathsRef.current.get(`${scopeKey}:${m.photo.uri}`);
    if (known) return known;
    if (!m.photo.uri.startsWith('data:')) return undefined;
    const capturedAccountKey = accountKeyRef.current;
    const capturedFlushGeneration = flushGenerationRef.current;
    const cacheKey = `${historyScopeKeyRef.current}:conversation:${conversationId}`;
    const uri = m.photo.uri;
    try {
      const uploaded = await api.uploadChatPhoto(uri, { accessToken });
      if (
        capturedAccountKey !== accountKeyRef.current ||
        capturedFlushGeneration !== flushGenerationRef.current
      ) {
        return undefined;
      }
      photoPathsRef.current.set(`${scopeKey}:${uri}`, uploaded.photoPath);
      const cached = conversationCacheRef.current.get(cacheKey);
      if (cached) {
        conversationCacheRef.current.set(cacheKey, {
          ...cached,
          messages: cached.messages.map(message =>
            message.photo?.uri === uri
              ? { ...message, photo: { ...message.photo, path: uploaded.photoPath } }
              : message),
        });
      }
      // Stamp the path onto every message holding this photo (the origin
      // plus any correction turns that re-used it) so their wire signatures
      // settle on the stored shape.
      if (scopeKeyRef.current === scopeKey) {
        setMessages(prev =>
          prev.map(x =>
            x.photo && x.photo.uri === uri && !x.photo.path
              ? { ...x, photo: { ...x.photo, path: uploaded.photoPath } }
              : x,
          ),
        );
      }
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
    const generation = flushGenerationRef.current;
    const activeAccountKey = accountKeyRef.current;
    // Bind every request in this drain to one token before an upload can
    // start. A generation/account recheck after the async token lookup means
    // a P1 photo can never be minted/finalized under a newly active P2.
    let accessToken: string | null;
    try {
      accessToken = await (getAccessToken ?? (async () => null))();
    } catch (error) {
      // The credential supplier can fail before any network request begins.
      // Keep the exact queued rows, report it, and retry only if this is
      // still the active drain generation. A stale P1 failure must never
      // release or schedule work for P2.
      if (generation === flushGenerationRef.current) {
        flushingRef.current = false;
        if (scopeKeyRef.current?.startsWith(`${activeAccountKey}:`)) {
          setConversationError(
            error instanceof Error
              ? `Could not save this conversation: ${error.message}`
              : 'Could not verify your session to save this conversation.',
          );
        }
        flushFailuresRef.current += 1;
        if (flushFailuresRef.current < 5 && !flushTimerRef.current) {
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            void flushOutbox();
          }, 5000);
        }
      }
      return;
    }
    if (
      generation !== flushGenerationRef.current ||
      accountKeyRef.current !== activeAccountKey ||
      !accessToken
    ) {
      if (generation === flushGenerationRef.current) flushingRef.current = false;
      return;
    }
    try {
      while (outboxRef.current.length > 0) {
        if (generation !== flushGenerationRef.current) break;
        // A parked P1 write must never authorize with P2's credentials, and
        // it must not prevent P2's own queue from draining.
        const firstIndex = outboxRef.current.findIndex(entry =>
          entry.scopeKey.startsWith(`${activeAccountKey}:`),
        );
        if (firstIndex < 0) break;
        const [first] = outboxRef.current.splice(firstIndex, 1);
        if (!first) break;
        const batch = [
          first,
          ...outboxRef.current.filter(
            entry => entry.scopeKey === first.scopeKey && entry.conversationId === first.conversationId,
          ),
        ].slice(0, 20);
        const batchKeys = new Set(batch.map(entry => `${entry.scopeKey}:${entry.message.id}`));
        outboxRef.current = outboxRef.current.filter(
          entry => !batchKeys.has(`${entry.scopeKey}:${entry.message.id}`),
        );
        const wires: ChatWireMessage[] = [];
        const sigs: Array<[string, string]> = [];
        for (const entry of batch) {
          const m = entry.message;
          if (m.status !== 'done' || m.role === 'staff') continue;
          const wire = toWireMessage(
            m,
            await storedPhotoPath(m, entry.api, entry.scopeKey, accessToken, entry.conversationId),
          );
          wires.push(wire);
          sigs.push([`${entry.scopeKey}:${m.id}`, JSON.stringify(wire)]);
        }
        if (generation !== flushGenerationRef.current) {
          // A revoke/account replacement deliberately purged the outbox.
          // Never reinsert private rows after an awaited photo upload lands.
          break;
        }
        if (wires.length === 0) continue;
        try {
          await first.api.appendCoachMessages(first.conversationId, wires, { accessToken });
          if (generation !== flushGenerationRef.current) break;
          for (const [id, sig] of sigs) persistedRef.current.set(id, sig);
          flushFailuresRef.current = 0;
        } catch (error) {
          // Never let a rejected append from a former account/revoked epoch
          // mutate UI or reinsert its batch after the purge.
          if (
            generation !== flushGenerationRef.current ||
            accountKeyRef.current !== activeAccountKey
          ) {
            break;
          }
          const status =
            error && typeof error === 'object' && 'status' in error
              ? (error as { status?: unknown }).status
              : undefined;
          if (status === 401 || status === 403) {
            revokeConversationAccess(
              error instanceof Error ? error.message : 'Your coach access is no longer available.',
            );
            break;
          }
          // Another device may have archived this exact conversation after
          // this client finalized a turn. Retrying that append forever cannot
          // succeed; keep the completed local transcript visible, switch this
          // conversation read-only, and make the save failure explicit.
          if (error instanceof Error && /archiv|409|conflict/i.test(error.message)) {
            if (scopeKeyRef.current === first.scopeKey) {
              setSelectedConversation(current =>
                current && current.id === first.conversationId
                  ? { ...current, archivedAt: current.archivedAt ?? new Date().toISOString() }
                  : current,
              );
              setConversationError(
                'This conversation was archived elsewhere before it finished saving. Restore it to continue.',
              );
            }
            flushFailuresRef.current = 0;
            continue;
          }
          // Requeue in place and back off; the transcript catches up in
          // order once the API is reachable again.
          if (scopeKeyRef.current === first.scopeKey) {
            setConversationError(
              error instanceof Error
                ? `Could not save this conversation: ${error.message}`
                : 'Could not save this conversation. We will retry when the connection returns.',
            );
          }
          outboxRef.current = [...batch, ...outboxRef.current];
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
      if (generation === flushGenerationRef.current) flushingRef.current = false;
    }
    // A message finalized while the drain above was mid-await re-enters
    // here rather than waiting for the next thread change.
    if (
      generation === flushGenerationRef.current &&
      outboxRef.current.some(entry => entry.scopeKey.startsWith(`${activeAccountKey}:`)) &&
      flushFailuresRef.current === 0
    ) {
      void flushOutbox();
    }
  }, [getAccessToken, revokeConversationAccess, storedPhotoPath]);

  useEffect(() => {
    if (accountKey.startsWith('real:')) void flushOutbox();
  }, [accountKey, flushOutbox]);

  // Coach availability: ask the server on open and whenever the account
  // changes. The demo persona is never paused; a probe that cannot answer
  // leaves the state alone (the chat request reports a pause on send).
  useEffect(() => {
    if (!realAccount) {
      setCoachPaused(null);
      return;
    }
    const controller = new AbortController();
    const getToken = getAccessToken ?? (async () => null);
    void fetchCoachAvailability(getToken, controller.signal).then(availability => {
      if (controller.signal.aborted || !availability) return;
      setCoachPaused(
        availability.available
          ? null
          : { message: availability.message ?? COACH_PAUSED_FALLBACK },
      );
    });
    return () => controller.abort();
    // The account key names the owner; the token getter follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  const startNewConversation = useCallback(() => {
    scopeEpochRef.current += 1;
    abortRef.current?.abort();
    if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
    revealRef.current = null;
    abortRef.current = null;
    inFlightRef.current = false;
    suggestionsRef.current.clear();
    updateLabelFlow(null);
    selectedConversationRef.current = null;
    pendingConversationIdRef.current = null;
    scopeKeyRef.current =
      accountRef.current.kind === 'real'
        ? `real:${(account as Extract<typeof account, { kind: 'real' }>).patientId}:epoch-${accountEpochRef.current}:fresh`
        : `demo:epoch-${accountEpochRef.current}:fresh`;
    setSelectedConversation(null);
    setPendingConversationId(null);
    setConversationError(null);
    setAccessDeniedError(null);
    setOlderBefore(null);
    setIsLoadingOlder(false);
    setIsConversationLoading(false);
    setIsConversationRefreshing(false);
    setLoadedConversationScopeKey(null);
    setPendingStage(null);
    setIsStreaming(false);
    const seed = accountRef.current.kind === 'demo' ? [buildFreshGreetingMessage()] : [buildFreshGreetingMessage()];
    messagesRef.current = seed;
    setMessages(seed);
    setRenderedScopeKey(scopeKeyRef.current);
  }, [account, updateLabelFlow]);

  const getCachedConversations = useCallback(
    (archived: boolean, offset = 0): CoachConversationPage | undefined => {
      const scope = historyScopeKey;
      if (!scope) return undefined;
      return historyCacheRef.current.get(`${scope}:${archived ? 'archived' : 'active'}:${offset}`)?.page;
    },
    [historyScopeKey],
  );

  const listConversations = useCallback(
    async (archived: boolean, offset = 0, force = false): Promise<CoachConversationPage> => {
      const scope = historyScopeKeyRef.current;
      const api = chatApiRef.current;
      if (accountRef.current.kind === 'demo') {
        const conversations = demoConversationsRef.current
          .filter(conversation => Boolean(conversation.archivedAt) === archived)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const slice = conversations.slice(offset, offset + 20);
        const page = {
          conversations: slice,
          total: conversations.length,
          nextOffset: offset + slice.length < conversations.length ? offset + slice.length : null,
        };
        if (scope) {
          historyCacheRef.current.set(`${scope}:${archived ? 'archived' : 'active'}:${offset}`, {
            page,
            fetchedAt: Date.now(),
          });
        }
        return page;
      }
      if (!api || !scope || accountRef.current.resolving) {
        throw new Error('Your coach conversations are still loading. Please try again.');
      }
      const cacheKey = `${scope}:${archived ? 'archived' : 'active'}:${offset}`;
      const cached = historyCacheRef.current.get(cacheKey);
      if (!force && cached && Date.now() - cached.fetchedAt < COACH_CONVERSATION_CACHE_TTL_MS) {
        return cached.page;
      }
      const inFlight = historyRequestsRef.current.get(cacheKey);
      if (inFlight) return inFlight;
      const requestGeneration = cacheGenerationRef.current;
      const request = api
        .listCoachConversations(archived, offset)
        .then(fetched => {
          if (
            cacheGenerationRef.current !== requestGeneration ||
            historyScopeKeyRef.current !== scope
          ) {
            throw staleCoachReadError();
          }
          const conversations = fetched.conversations
            .map(reconcileConversation)
            .filter(row => Boolean(row.archivedAt) === archived);
          const page = conversations.length === fetched.conversations.length
            && conversations.every((row, index) => row === fetched.conversations[index])
            ? fetched
            : { ...fetched, conversations };
          historyCacheRef.current.set(cacheKey, { page, fetchedAt: Date.now() });
          setAccessDeniedError(null);
          return page;
        })
        .catch(error => {
          if (cacheGenerationRef.current !== requestGeneration || historyScopeKeyRef.current !== scope) {
            throw staleCoachReadError();
          }
          // A terminal access/not-found response makes retained rows unsafe;
          // transient failures intentionally leave the stale page available.
          const status =
            error && typeof error === 'object' && 'status' in error
              ? (error as { status?: unknown }).status
              : undefined;
          if (status === 401 || status === 403) {
            revokeConversationAccess(
              error instanceof Error ? error.message : 'Your coach access is no longer available.',
            );
          } else if (isTerminalConversationAccessError(error)) {
            historyCacheRef.current.delete(cacheKey);
          }
          throw error;
        })
        .finally(() => {
          if (historyRequestsRef.current.get(cacheKey) === request) {
            historyRequestsRef.current.delete(cacheKey);
          }
        });
      historyRequestsRef.current.set(cacheKey, request);
      return request;
    },
    [revokeConversationAccess],
  );

  const selectConversation = useCallback(
    async (id: string, force = false) => {
      const api = chatApiRef.current;
      const epoch = ++scopeEpochRef.current;
      const selection = ++selectionRequestRef.current;
      const identity = accountKeyRef.current;
      const historyScope = historyScopeKeyRef.current;
      const scopeKey = `${identity}:epoch-${accountEpochRef.current}:${id}`;
      const cacheKey = historyScope ? `${historyScope}:conversation:${id}` : null;
      const cached = cacheKey ? conversationCacheRef.current.get(cacheKey) : undefined;
      const outgoing = selectedConversationRef.current;
      const outgoingScope = scopeKeyRef.current;
      if (
        historyScope &&
        outgoing &&
        outgoingScope?.startsWith(`${identity}:`) &&
        outgoingScope !== scopeKey
      ) {
        // Selection aborts a live stream. Keep finalized local turns for a
        // warm return, but never cache a transient waiting/reveal bubble.
        conversationCacheRef.current.set(`${historyScope}:conversation:${outgoing.id}`, {
          conversation: outgoing,
          messages: messagesRef.current.filter(message => message.status === 'done'),
          nextBefore: olderBefore,
          // Moving away never validates the newest server page.
          fetchedAt:
            conversationCacheRef.current.get(`${historyScope}:conversation:${outgoing.id}`)?.fetchedAt ?? 0,
          serverMessageIds:
            conversationCacheRef.current.get(`${historyScope}:conversation:${outgoing.id}`)?.serverMessageIds ??
            new Set(),
        });
      }
      abortRef.current?.abort();
      if (revealRef.current?.timer) clearInterval(revealRef.current.timer);
      revealRef.current = null;
      abortRef.current = null;
      inFlightRef.current = false;
      suggestionsRef.current.clear();
      updateLabelFlow(null);
      setIsStreaming(false);
      setPendingStage(null);
      setConversationError(null);
      setOlderBefore(null);
      isLoadingOlderRef.current = false;
      setIsLoadingOlder(false);
      // Establish the destination before any await. A loaded cache remains
      // usable while stale data refreshes; an unknown destination blanks the
      // outgoing transcript immediately.
      pendingConversationIdRef.current = id;
      scopeKeyRef.current = scopeKey;
      setPendingConversationId(id);
      selectedConversationRef.current = cached?.conversation ?? null;
      setSelectedConversation(cached?.conversation ?? null);
      if (cached) {
        // These maps are already keyed by account epoch AND conversation.
        // Retain off-screen upload/save confirmations across thread changes.
        // Only account reset/revocation may purge all scoped bookkeeping.
        for (const message of cached.messages) {
          if (cached.serverMessageIds.has(message.id) && !persistedRef.current.has(`${scopeKey}:${message.id}`)) {
            persistedRef.current.set(`${scopeKey}:${message.id}`, JSON.stringify(toWireMessage(message)));
          }
          if (message.photo?.path) {
            photoPathsRef.current.set(`${scopeKey}:${message.photo.uri}`, message.photo.path);
          }
          if (message.card?.kind === 'recipe') {
            const suggestion = parseRecipeCardPayload(message.card.payload);
            if (suggestion) {
              const origin = message.replyToId
                ? cached.messages.find(candidate => candidate.id === message.replyToId)
                : undefined;
              suggestionsRef.current.set(
                suggestion.id,
                suggestion.mode === 'meal' && origin?.photo?.uri
                  ? { ...suggestion, photoUri: origin.photo.uri }
                  : suggestion,
              );
            }
          }
        }
        hydratedKeyRef.current = scopeKey;
        messagesRef.current = cached.messages;
        setMessages(cached.messages);
        setOlderBefore(cached.nextBefore);
        setRenderedScopeKey(scopeKey);
        setLoadedConversationScopeKey(scopeKey);
      } else {
        messagesRef.current = [];
        setMessages([]);
        setRenderedScopeKey(null);
        setLoadedConversationScopeKey(null);
      }
      const cacheIsFresh =
        cached && Date.now() - cached.fetchedAt < COACH_CONVERSATION_CACHE_TTL_MS;
      setIsConversationLoading(!cached);
      setIsConversationRefreshing(Boolean(cached && (!cacheIsFresh || force)));

      if (accountRef.current.kind === 'demo') {
        const conversation = demoConversationsRef.current.find(row => row.id === id);
        if (!conversation) {
          if (selectionRequestRef.current === selection && accountKeyRef.current === identity) {
            setConversationError('That conversation is no longer available.');
            setIsConversationLoading(false);
            setIsConversationRefreshing(false);
          }
          return;
        }
        if (selectionRequestRef.current !== selection || accountKeyRef.current !== identity) return;
        const restored = (conversation as CoachConversation & { messages?: CoachMessage[] }).messages ?? [
          buildFreshGreetingMessage(),
        ];
        selectedConversationRef.current = conversation;
        pendingConversationIdRef.current = null;
        hydratedKeyRef.current = `demo:epoch-${accountEpochRef.current}:${conversation.id}`;
        setSelectedConversation(conversation);
        setPendingConversationId(null);
        setOlderBefore(null);
        messagesRef.current = restored;
        setMessages(restored);
        setRenderedScopeKey(scopeKey);
        setLoadedConversationScopeKey(scopeKey);
        setIsConversationLoading(false);
        setIsConversationRefreshing(false);
        return;
      }
      if (!api || !cacheKey) {
        if (selectionRequestRef.current === selection && accountKeyRef.current === identity) {
          setConversationError('Your coach conversations are still loading. Please try again.');
          setIsConversationLoading(false);
          setIsConversationRefreshing(false);
        }
        return;
      }
      if (cacheIsFresh && !force) {
        if (selectionRequestRef.current === selection && accountKeyRef.current === identity) {
          pendingConversationIdRef.current = null;
          setPendingConversationId(null);
          setIsConversationLoading(false);
          setIsConversationRefreshing(false);
        }
        return;
      }
      let request = conversationRequestsRef.current.get(cacheKey);
      if (!request) {
        const requestGeneration = cacheGenerationRef.current;
        request = api.fetchCoachConversation(id, undefined, localTodayKey()).then(snapshot => {
          const entry: CachedConversation = {
            conversation: reconcileConversation(snapshot.conversation),
            messages: snapshot.messages.map(wireToCoachMessage),
            nextBefore: snapshot.nextBefore,
            fetchedAt: Date.now(),
            serverMessageIds: new Set(snapshot.messages.map(message => message.id)),
          };
          if (
            cacheGenerationRef.current === requestGeneration &&
            historyScopeKeyRef.current === historyScope
          ) {
            conversationCacheRef.current.set(cacheKey, entry);
          }
          return entry;
        });
        conversationRequestsRef.current.set(cacheKey, request);
        void request.then(
          () => {
            if (conversationRequestsRef.current.get(cacheKey) === request) {
              conversationRequestsRef.current.delete(cacheKey);
            }
          },
          () => {
            if (conversationRequestsRef.current.get(cacheKey) === request) {
              conversationRequestsRef.current.delete(cacheKey);
            }
          },
        );
      }
      try {
        const loaded = await request;
        // A→B→A is valid: only the latest A selection owns this paint. A
        // completion for an account that signed out/replaced never can.
        if (
          selectionRequestRef.current !== selection ||
          scopeEpochRef.current !== epoch ||
          accountKeyRef.current !== identity ||
          scopeKeyRef.current !== scopeKey
        ) {
          return;
        }
        // A refresh is a newest-page replacement, not permission to discard
        // local finalized/outbox turns, a paced reply, or pages already
        // loaded above this cursor. Merge by id against the CURRENT scope.
        const currentMessages = messagesRef.current;
        const incomingIds = new Set(loaded.messages.map(message => message.id));
        const preservedOlder = currentMessages.filter(
          message => !incomingIds.has(message.id) && message.seq !== undefined,
        );
        const preservedLocal = currentMessages.filter(
          message => !incomingIds.has(message.id) && message.seq === undefined,
        );
        const currentById = new Map(currentMessages.map(message => [message.id, message]));
        const mergedMessages = [
          ...preservedOlder,
          ...loaded.messages.map(message => {
            const current = currentById.get(message.id);
            return current && current.status !== 'done' ? current : message;
          }),
          ...preservedLocal,
        ];
        const nextBefore =
          preservedOlder.length > 0 ? olderBefore : loaded.nextBefore;
        const priorPersisted = new Map(persistedRef.current);
        const incomingById = new Map(loaded.messages.map(message => [message.id, message]));
        for (const message of mergedMessages) {
          // Only the just-read server version establishes a new persistence
          // signature. A preserved local/outbox row remains unsaved unless a
          // prior signature already proved it landed.
          if (incomingById.get(message.id) === message) {
            persistedRef.current.set(`${scopeKey}:${message.id}`, JSON.stringify(toWireMessage(message)));
          } else {
            const known = priorPersisted.get(`${scopeKey}:${message.id}`);
            if (known) persistedRef.current.set(`${scopeKey}:${message.id}`, known);
          }
          if (message.photo?.path) {
            photoPathsRef.current.set(`${scopeKey}:${message.photo.uri}`, message.photo.path);
          }
          if (message.card?.kind === 'recipe') {
            const suggestion = parseRecipeCardPayload(message.card.payload);
            if (suggestion) {
              const origin = message.replyToId
                ? mergedMessages.find(candidate => candidate.id === message.replyToId)
                : undefined;
              suggestionsRef.current.set(
                suggestion.id,
                suggestion.mode === 'meal' && origin?.photo?.uri
                  ? { ...suggestion, photoUri: origin.photo.uri }
                  : suggestion,
              );
            }
          }
        }
        hydratedKeyRef.current = scopeKey;
        setAccessDeniedError(null);
        selectedConversationRef.current = loaded.conversation;
        pendingConversationIdRef.current = null;
        setSelectedConversation(loaded.conversation);
        setPendingConversationId(null);
        setOlderBefore(nextBefore);
        messagesRef.current = mergedMessages;
        setMessages(mergedMessages);
        setRenderedScopeKey(scopeKey);
        setLoadedConversationScopeKey(scopeKey);
        conversationCacheRef.current.set(cacheKey, {
          conversation: loaded.conversation,
          messages: mergedMessages,
          nextBefore,
          // Only a successful newest-page read refreshes cache freshness.
          fetchedAt: loaded.fetchedAt,
          serverMessageIds: new Set(loaded.serverMessageIds),
        });
      } catch (error) {
        if (
          selectionRequestRef.current !== selection ||
          scopeEpochRef.current !== epoch ||
          accountKeyRef.current !== identity ||
          scopeKeyRef.current !== scopeKey
        ) {
          return;
        }
        const status =
          error && typeof error === 'object' && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        if (status === 401 || status === 403) {
          revokeConversationAccess(
            error instanceof Error ? error.message : 'Your coach access is no longer available.',
          );
        } else if (isTerminalConversationAccessError(error)) {
          conversationCacheRef.current.delete(cacheKey);
          for (const key of historyCacheRef.current.keys()) {
            if (key.startsWith(`${historyScope}:`)) historyCacheRef.current.delete(key);
          }
          selectedConversationRef.current = null;
          messagesRef.current = [];
          setSelectedConversation(null);
          setMessages([]);
          setRenderedScopeKey(null);
          setLoadedConversationScopeKey(null);
        } else if (cached) {
          // A retryable background failure does not revoke the transcript we
          // already have. It remains readable/sendable and Retry can force a
          // new request; only a cold/terminal failure keeps the send gate shut.
          pendingConversationIdRef.current = null;
          setPendingConversationId(null);
        }
        setConversationError(
          error instanceof Error ? error.message : 'Could not load this conversation. Please try again.',
        );
        throw error;
      } finally {
        if (
          selectionRequestRef.current === selection &&
          scopeEpochRef.current === epoch &&
          accountKeyRef.current === identity &&
          scopeKeyRef.current === scopeKey
        ) {
          setIsConversationLoading(false);
          setIsConversationRefreshing(false);
        }
      }
    },
    [olderBefore, revokeConversationAccess, updateLabelFlow],
  );

  const loadOlder = useCallback(async () => {
    const conversation = selectedConversationRef.current;
    const api = chatApiRef.current;
    const before = olderBefore;
    const scopeKey = scopeKeyRef.current;
    const epoch = scopeEpochRef.current;
    if (!conversation || !api || before === null || !scopeKey || isLoadingOlderRef.current) return;
    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);
    try {
      const snapshot = await api.fetchCoachConversation(conversation.id, before, localTodayKey());
      if (scopeEpochRef.current !== epoch || scopeKeyRef.current !== scopeKey) return;
      const incoming = snapshot.messages.map(wireToCoachMessage);
      for (const message of incoming) {
        persistedRef.current.set(`${scopeKey}:${message.id}`, JSON.stringify(toWireMessage(message)));
      }
      // Snapshot before dispatching. React may eagerly run a functional state
      // updater, so calculating additions afterwards can accidentally compare
      // a page against the very merged ref it just created.
      const known = new Set(messagesRef.current.map(message => message.id));
      const added = incoming.filter(message => !known.has(message.id));
      const merged = [...added, ...messagesRef.current];
      messagesRef.current = merged;
      setMessages(merged);
      const historyScope = historyScopeKeyRef.current;
      if (historyScope) {
        conversationCacheRef.current.set(`${historyScope}:conversation:${conversation.id}`, {
          conversation,
          messages: merged,
          nextBefore: snapshot.nextBefore,
          // Older pagination cannot validate freshness of the newest page.
          fetchedAt:
            conversationCacheRef.current.get(`${historyScope}:conversation:${conversation.id}`)?.fetchedAt ?? 0,
          serverMessageIds: new Set([
            ...(conversationCacheRef.current.get(`${historyScope}:conversation:${conversation.id}`)?.serverMessageIds ?? []),
            ...incoming.map(message => message.id),
          ]),
        });
      }
      // A duplicate page can still be useful when its cursor advances: accept
      // that cursor and continue. Only a duplicate page pointing to the same
      // cursor is a no-progress loop; a clean null cursor is normal exhaustion.
      if (added.length === 0 && snapshot.nextBefore === before) {
        setOlderBefore(null);
        setConversationError('Could not load older messages. Please try again.');
        return;
      }
      setOlderBefore(snapshot.nextBefore);
    } catch (error) {
      if (scopeEpochRef.current === epoch && scopeKeyRef.current === scopeKey) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        if (status === 401 || status === 403) {
          revokeConversationAccess(
            error instanceof Error ? error.message : 'Your coach access is no longer available.',
          );
        } else {
          setConversationError(
            error instanceof Error ? error.message : 'Could not load older messages. Please try again.',
          );
        }
      }
    } finally {
      if (scopeEpochRef.current === epoch && scopeKeyRef.current === scopeKey) {
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
      }
    }
  }, [olderBefore, revokeConversationAccess]);

  const setArchived = useCallback(
    async (conversation: CoachConversation, archived: boolean) => {
      const operationAccount = accountKeyRef.current;
      const operationGeneration = cacheGenerationRef.current;
      const operationCurrent = () =>
        accountKeyRef.current === operationAccount && cacheGenerationRef.current === operationGeneration;
      const invalidateHistory = () => {
        const scope = historyScopeKeyRef.current;
        if (!scope) return;
        for (const key of historyCacheRef.current.keys()) {
          if (key.startsWith(`${scope}:`)) historyCacheRef.current.delete(key);
        }
        conversationCacheRef.current.delete(`${scope}:conversation:${conversation.id}`);
      };
      const isSelected = selectedConversationRef.current?.id === conversation.id;
      if (archived && isSelected && inFlightRef.current) {
        const message = 'Wait for the coach response to finish or stop it before archiving this conversation.';
        setConversationError(message);
        throw new Error(message);
      }
      if (archived && isSelected) {
        // Persist the exact finalized transcript before the server closes the
        // append gate. Do not silently park an append that an archive would
        // make permanently invalid.
        const scopeKey = scopeKeyRef.current;
        const api = chatApiRef.current;
        if (scopeKey && api && accountRef.current.kind === 'real') {
          for (const message of messagesRef.current) {
            if (message.status !== 'done' || message.role === 'staff') continue;
            const signature = JSON.stringify(
              toWireMessage(
                message,
                message.photo
                  ? photoPathsRef.current.get(`${scopeKey}:${message.photo.uri}`)
                  : undefined,
              ),
            );
            if (persistedRef.current.get(`${scopeKey}:${message.id}`) === signature) continue;
            const entry: CoachOutboxEntry = {
              scopeKey,
              conversationId: conversation.id,
              api,
              message,
            };
            const index = outboxRef.current.findIndex(
              queued => queued.scopeKey === scopeKey && queued.message.id === message.id,
            );
            if (index === -1) outboxRef.current.push(entry);
            else outboxRef.current[index] = entry;
          }
        }
        await flushOutbox();
        if (!operationCurrent()) throw staleCoachReadError();
        if (outboxRef.current.some(entry => entry.conversationId === conversation.id)) {
          const message = 'This conversation is still saving. Please try archiving again in a moment.';
          setConversationError(message);
          throw new Error(message);
        }
      }
      if (accountRef.current.kind === 'demo') {
        const updated = { ...conversation, archivedAt: archived ? new Date().toISOString() : null, version: conversation.version + 1 };
        demoConversationsRef.current = demoConversationsRef.current.map(row =>
          row.id === conversation.id ? updated : row,
        );
        if (selectedConversationRef.current?.id === conversation.id) {
          selectedConversationRef.current = updated;
          setSelectedConversation(updated);
        }
        invalidateHistory();
        return;
      }
      const api = chatApiRef.current;
      if (!api) throw new Error('Your coach conversations are still loading. Please try again.');
      try {
        const updated = await api.updateCoachConversation(conversation.id, archived, conversation.version);
        if (!operationCurrent()) throw staleCoachReadError();
        committedConversationsRef.current.set(updated.id, updated);
        if (selectedConversationRef.current?.id === updated.id) {
          selectedConversationRef.current = updated;
          setSelectedConversation(updated);
        }
        invalidateHistory();
      } catch (error) {
        if (!operationCurrent()) throw staleCoachReadError();
        const message =
          error instanceof Error
            ? error.message
            : 'Could not update this conversation. Refresh and try again.';
        const status =
          error && typeof error === 'object' && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        if (status === 401 || status === 403) revokeConversationAccess(message);
        else setConversationError(message);
        throw error;
      }
    },
    [flushOutbox, revokeConversationAccess],
  );

  const renameConversation = useCallback(
    async (conversation: CoachConversation, rawTitle: string): Promise<CoachConversation> => {
      const title = cleanCoachTitle(rawTitle);
      if (!title) throw new Error(`Give the conversation a name of 1 to ${COACH_TITLE_MAX_CHARS} characters.`);
      const operationAccount = accountKeyRef.current;
      const operationGeneration = cacheGenerationRef.current;
      const operationCurrent = () =>
        accountKeyRef.current === operationAccount && cacheGenerationRef.current === operationGeneration;
      const applyRenamed = (updated: CoachConversation) => {
        const scope = historyScopeKeyRef.current;
        if (scope) {
          for (const key of historyCacheRef.current.keys()) {
            if (key.startsWith(`${scope}:`)) historyCacheRef.current.delete(key);
          }
          conversationCacheRef.current.delete(`${scope}:conversation:${conversation.id}`);
        }
        if (selectedConversationRef.current?.id === updated.id) {
          selectedConversationRef.current = { ...selectedConversationRef.current, ...updated };
          setSelectedConversation(selectedConversationRef.current);
        }
      };
      if (accountRef.current.kind === 'demo') {
        const updated = { ...conversation, title, titleState: 'ready' as const, version: conversation.version + 1 };
        demoRenamedRef.current.add(conversation.id);
        demoConversationsRef.current = demoConversationsRef.current.map(row =>
          row.id === conversation.id ? { ...row, ...updated } : row,
        );
        applyRenamed(updated);
        return updated;
      }
      const api = chatApiRef.current;
      if (!api) throw new Error('Your coach conversations are still loading. Please try again.');
      try {
        const updated = await api.renameCoachConversation(conversation.id, title, conversation.version);
        if (!operationCurrent()) throw staleCoachReadError();
        committedConversationsRef.current.set(updated.id, updated);
        applyRenamed(updated);
        return updated;
      } catch (error) {
        if (!operationCurrent()) throw staleCoachReadError();
        const status =
          error && typeof error === 'object' && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        if (status === 401 || status === 403) {
          revokeConversationAccess(error instanceof Error ? error.message : 'Conversation access is unavailable.');
        }
        throw error;
      }
    },
    [reconcileConversation, revokeConversationAccess],
  );

  const refreshThread = useCallback(async (force = false) => {
    // Never replace a live paced exchange with a focus/sync refresh; the
    // stream owns this transcript until it finalizes or the patient stops it.
    if (isLoadingOlderRef.current || inFlightRef.current) return;
    const id = selectedConversationRef.current?.id ?? pendingConversationIdRef.current;
    if (!id) return;
    await selectConversation(id, force);
  }, [selectConversation]);

  useEffect(() => {
    if (!realAccount) return;
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') void refreshThread(true).catch(() => {});
    });
    const unsubscribe = subscribeChatSync(thread => {
      if (thread === 'coach') void refreshThread(true).catch(() => {});
    });
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [realAccount, refreshThread]);


  // Persistence: whenever the thread changes, enqueue every finalized
  // message whose wire shape differs from what the account already stores —
  // user turns land at send, assistant replies once the reveal finalizes
  // them (stopped ones included), and later mutations of a stored message
  // (card updates, the hidden flip, a photo path landing) re-upsert its row.
  // Streaming and error bubbles never match `done`, so they never persist.
  useEffect(() => {
    const conversation = selectedConversationRef.current;
    const scopeKey = conversationScopeKey;
    if (!realAccount || !conversation || !scopeKey || hydratedKeyRef.current !== scopeKey) return;
    let queued = false;
    for (const m of messages) {
      if (m.status !== 'done' || m.role === 'staff') continue;
      const sig = JSON.stringify(
        toWireMessage(m, m.photo ? photoPathsRef.current.get(`${scopeKey}:${m.photo.uri}`) : undefined),
      );
      const persistedKey = `${scopeKey}:${m.id}`;
      if (persistedRef.current.get(persistedKey) === sig) continue;
      const entry: CoachOutboxEntry = {
        scopeKey,
        conversationId: conversation.id,
        api: realAccount.api,
        message: m,
      };
      const existing = outboxRef.current.findIndex(
        queuedEntry => queuedEntry.scopeKey === scopeKey && queuedEntry.message.id === m.id,
      );
      if (existing === -1) outboxRef.current.push(entry);
      else outboxRef.current[existing] = entry;
      queued = true;
    }
    if (queued) void flushOutbox();
  }, [messages, realAccount, conversationScopeKey, selectedConversation, flushOutbox]);

  // Demo is deliberately local, but still offers coherent multiple
  // conversations for history previews without fabricating server history.
  useEffect(() => {
    const conversation = selectedConversationRef.current;
    if (accountRef.current.kind !== 'demo' || !conversation) return;
    const stored = { ...conversation, updatedAt: new Date().toISOString(), messages } as CoachConversation & {
      messages: CoachMessage[];
    };
    // Name the demo conversation from its first message, the way the server
    // job does for real accounts; a patient rename is never replaced.
    if (stored.title === DEFAULT_COACH_TITLE && !demoRenamedRef.current.has(conversation.id)) {
      const first = messages.find(message => message.role === 'user' && message.text.trim());
      if (first) {
        stored.title = demoCoachTitleFromMessage(first.text);
        selectedConversationRef.current = { ...conversation, title: stored.title };
        setSelectedConversation(selectedConversationRef.current);
      }
    }
    demoConversationsRef.current = demoConversationsRef.current.map(row =>
      row.id === conversation.id ? stored : row,
    );
  }, [messages]);

  // Keep finalized local turns available on a warm return. stop() produces a
  // deliberate fragment after the initial server snapshot; without this a
  // same-conversation cache hit could resurrect that older snapshot and hide
  // the patient's own finalized turn.
  useEffect(() => {
    const conversation = selectedConversationRef.current;
    const historyScope = historyScopeKeyRef.current;
    const scopeKey = scopeKeyRef.current;
    if (
      !conversation ||
      !historyScope ||
      !scopeKey ||
      scopeKey !== `${historyScope}:${conversation.id}` ||
      isStreaming
    ) {
      return;
    }
    conversationCacheRef.current.set(`${historyScope}:conversation:${conversation.id}`, {
      conversation,
      messages: messagesRef.current.filter(message => message.status === 'done'),
      nextBefore: olderBefore,
      // A local finalization is not a server newest-page validation.
      fetchedAt:
        conversationCacheRef.current.get(`${historyScope}:conversation:${conversation.id}`)?.fetchedAt ?? 0,
      serverMessageIds:
        conversationCacheRef.current.get(`${historyScope}:conversation:${conversation.id}`)?.serverMessageIds ??
        new Set(),
    });
  }, [messages, isStreaming, olderBefore, selectedConversation]);

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
      const capturedScopeKey = scopeKeyRef.current;
      const capturedEpoch = scopeEpochRef.current;
      const isStale = () =>
        abortRef.current !== controller ||
        scopeKeyRef.current !== capturedScopeKey ||
        scopeEpochRef.current !== capturedEpoch;

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
      const dietContext = dietContextRef.current;
      void streamCoachChat(
        auth.kind === 'demo'
          ? body
          : { ...body, localDate: localTodayKey(), ...(dietContext ? { dietContext } : {}) },
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
          onError: (message, retryable, details) => {
            if (isStale()) return;
            // The error replaces the reply wholesale — drop the unrevealed
            // buffer and any held card/quick replies with it.
            if (reveal.timer) {
              clearInterval(reveal.timer);
              reveal.timer = null;
            }
            revealRef.current = null;
            abortRef.current = null;
            // A pause is policy, not a fault: the notice takes over the
            // composer, and the waiting bubble is withdrawn rather than
            // shown as an error the patient might retry.
            if (details?.coachPaused) {
              setCoachPaused({ message });
              setMessages(current => current.filter(m => m.id !== assistantId));
            } else {
              setMessages(current =>
                current.map(m =>
                  m.id === assistantId ? { ...m, status: 'error', text: message, retryable } : m,
                ),
              );
            }
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
   * Materializes a server row only at the send gate. The captured account
   * identity/epoch prevents a delayed create response from selecting a chat
   * after sign-out or after the patient chose another conversation.
   */
  const ensureConversation = useCallback(async (): Promise<CoachConversation | null> => {
    // A selected destination without a transcript must finish (or report its
    // error) before a send may create anything. This is the last gate against
    // a tap during a cold A→B selection landing in a brand-new conversation.
    const current = selectedConversationRef.current;
    if (pendingConversationIdRef.current && current?.id !== pendingConversationIdRef.current) return null;
    if (current) return current;
    const epoch = scopeEpochRef.current;
    const identity = accountKeyRef.current;
    if (accountRef.current.kind === 'demo') {
      const now = new Date().toISOString();
      const conversation: CoachConversation & { messages?: CoachMessage[] } = {
        id: `demo-coach-${++demoConversationCounterRef.current}`,
        title: DEFAULT_COACH_TITLE,
        titleState: 'ready',
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        processingState: 'ready',
        messages: messagesRef.current,
      };
      if (scopeEpochRef.current !== epoch || accountKeyRef.current !== identity) return null;
      demoConversationsRef.current = [conversation, ...demoConversationsRef.current];
      const historyScope = historyScopeKeyRef.current;
      if (historyScope) {
        for (const key of historyCacheRef.current.keys()) {
          if (key.startsWith(`${historyScope}:`)) historyCacheRef.current.delete(key);
        }
      }
      selectedConversationRef.current = conversation;
      pendingConversationIdRef.current = null;
      scopeKeyRef.current = `demo:epoch-${accountEpochRef.current}:${conversation.id}`;
      setSelectedConversation(conversation);
      setPendingConversationId(null);
      setRenderedScopeKey(`demo:epoch-${accountEpochRef.current}:${conversation.id}`);
      return conversation;
    }
    const api = chatApiRef.current;
    if (!api || accountRef.current.resolving) return null;
    try {
      const conversation = await api.createCoachConversation(
        `coach-${sessionNonceRef.current}-${++idRef.current}`,
      );
      if (scopeEpochRef.current !== epoch || accountKeyRef.current !== identity) return null;
      const scopeKey = `real:${(account as Extract<typeof account, { kind: 'real' }>).patientId}:epoch-${accountEpochRef.current}:${conversation.id}`;
      const historyScope = historyScopeKeyRef.current;
      if (historyScope) {
        for (const key of historyCacheRef.current.keys()) {
          if (key.startsWith(`${historyScope}:`)) historyCacheRef.current.delete(key);
        }
      }
      selectedConversationRef.current = conversation;
      pendingConversationIdRef.current = null;
      scopeKeyRef.current = scopeKey;
      setSelectedConversation(conversation);
      setPendingConversationId(null);
      hydratedKeyRef.current = scopeKey;
      setRenderedScopeKey(scopeKey);
      return conversation;
    } catch (error) {
      if (scopeEpochRef.current === epoch && accountKeyRef.current === identity) {
        setConversationError(
          error instanceof Error ? error.message : 'Could not start a new conversation. Please try again.',
        );
      }
      return null;
    }
  }, [account]);

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
      void (async () => {
      const text = rawText.trim();
      if (!text || inFlightRef.current) return;
      // While a signed-in account is still resolving, hold sends: the thread
      // is about to be reseeded for its owner, and a turn fired now would
      // ground on the wrong patient and then vanish in the reset.
      if (accountRef.current.resolving) return;
      // Care team has the coach paused: the composer is closed on screen;
      // a stray submit (keyboard "send") must not open a turn either.
      if (coachPausedRef.current) return;
      if (selectedConversationRef.current?.archivedAt) return;
      // New Chat remains local until this substantive send succeeds.
      // This lock is deliberately acquired before the create await: two rapid
      // taps must not materialize two different first conversations.
      inFlightRef.current = true;
      const conversation = await ensureConversation();
      if (!conversation || conversation.archivedAt) {
        inFlightRef.current = false;
        return;
      }
      // An active label flow answers this text client-side — the name
      // conversation is deterministic state, never a model exchange.
      const flow = labelFlowRef.current;
      if (flow) {
        resolveLabelFlowText(flow, text);
        inFlightRef.current = false;
        return;
      }

      // Any reply while the outreach is in the thread counts as engagement:
      // the proactive conversation stops re-opening once the patient has
      // answered in any form (fire-and-forget; the guard is idempotent).
      if (messagesRef.current.some(m => isOutreachMessageId(m.id))) {
        void markNudgeEngaged();
      }

      // The outreach's decline chip and its follow-up resolve client-side,
      // like the label flow: fixed coach strings, no model call. Anything
      // typed instead of the exact chip labels falls through to the coach.
      const latestMessage = messagesRef.current[messagesRef.current.length - 1];
      if (latestMessage && isOutreachMessageId(latestMessage.id) && text === OUTREACH_DECLINE) {
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
        inFlightRef.current = false;
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
        inFlightRef.current = false;
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
            ...(accountRef.current.kind === 'real' ? { conversationId: conversation.id } : {}),
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
        {
          messages: request,
          ...(accountRef.current.kind === 'real' ? { conversationId: conversation.id } : {}),
          localTime: localTimeForDate(clock()),
        },
        assistantId,
        controller,
      );
      })();
    },
    [streamInto, clock, resolveLabelFlowText, markNudgeEngaged, setNudgeOptOut, ensureConversation],
  );

  const sendPhoto = useCallback(
    (
      photo: { uri: string; width: number; height: number },
      kind?: PhotoKind,
      options?: SendPhotoOptions,
    ) => {
      void (async () => {
      if (!photo.uri || inFlightRef.current) return;
      if (accountRef.current.resolving) return;
      if (coachPausedRef.current) return;
      if (selectedConversationRef.current?.archivedAt) return;
      // See send(): this closes the new-conversation double-tap race before
      // awaiting the idempotent server create.
      inFlightRef.current = true;
      const conversation = await ensureConversation();
      if (!conversation || conversation.archivedAt) {
        inFlightRef.current = false;
        return;
      }
      // A photo reply counts as engagement exactly like a text reply.
      if (messagesRef.current.some(m => isOutreachMessageId(m.id))) {
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
          ...(accountRef.current.kind === 'real' ? { conversationId: conversation.id } : {}),
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
      })();
    },
    [streamInto, clock, updateLabelFlow, markNudgeEngaged, ensureConversation],
  );

  const retry = useCallback(
    (assistantMessageId: string) => {
      if (inFlightRef.current) return;
      if (accountRef.current.resolving) return;
      const conversation = selectedConversationRef.current;
      if (!conversation || conversation.archivedAt) return;
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
          conversationId: conversation.id,
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
    flushGenerationRef.current += 1;
    scopeEpochRef.current += 1;
    selectionRequestRef.current += 1;
    cacheGenerationRef.current += 1;
    accountEpochRef.current += 1;
    setAccountEpoch(accountEpochRef.current);
    conversationCacheRef.current.clear();
    conversationRequestsRef.current.clear();
    historyCacheRef.current.clear();
    committedConversationsRef.current.clear();
    historyRequestsRef.current.clear();
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
    selectedConversationRef.current = null;
    pendingConversationIdRef.current = null;
    scopeKeyRef.current =
      accountRef.current.resolving
        ? null
        : accountRef.current.kind === 'real'
          ? `${accountKeyRef.current}:epoch-${accountEpochRef.current}:fresh`
          : `demo:epoch-${accountEpochRef.current}:fresh`;
    setSelectedConversation(null);
    setPendingConversationId(null);
    setConversationError(null);
    setAccessDeniedError(null);
    setOlderBefore(null);
    isLoadingOlderRef.current = false;
    setIsLoadingOlder(false);
    setIsConversationLoading(false);
    setIsConversationRefreshing(false);
    setLoadedConversationScopeKey(null);
    const seed =
      !accountRef.current.resolving && accountRef.current.kind === 'demo'
        ? [buildGreetingMessage()]
        : [];
    messagesRef.current = seed;
    setMessages(seed);
    setRenderedScopeKey(scopeKeyRef.current);
  }, [updateLabelFlow]);

  const visibleMessages = renderedScopeKey === conversationScopeKey ? messages : [];
  // A fresh composer is a ready local destination, even though it correctly
  // has no server transcript/row yet. Only a selected cold/error destination
  // is "not loaded" and must keep the composer blocked.
  const hasConversationLoaded =
    loadedConversationScopeKey === conversationScopeKey ||
    Boolean(conversationScopeKey?.endsWith(':fresh'));

  const value = useMemo(
    () => ({
      messages: visibleMessages,
      isStreaming,
      pendingStage,
      selectedConversation,
      conversationScopeKey,
      historyScopeKey,
      conversationError,
      accessDeniedError,
      isConversationLoading,
      isConversationRefreshing,
      hasConversationLoaded,
      hasOlderMessages: olderBefore !== null,
      isLoadingOlder,
      startNewConversation,
      selectConversation,
      getCachedConversations,
      listConversations,
      setArchived,
      renameConversation,
      loadOlder,
      refreshThread,
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
      coachPaused,
    }),
    [
      visibleMessages,
      isStreaming,
      pendingStage,
      selectedConversation,
      conversationScopeKey,
      historyScopeKey,
      conversationError,
      accessDeniedError,
      isConversationLoading,
      isConversationRefreshing,
      hasConversationLoaded,
      olderBefore,
      isLoadingOlder,
      startNewConversation,
      selectConversation,
      getCachedConversations,
      listConversations,
      setArchived,
      renameConversation,
      loadOlder,
      refreshThread,
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
      coachPaused,
    ],
  );

  return <CoachChatContext.Provider value={value}>{children}</CoachChatContext.Provider>;
}

export function useCoachChat(): CoachChatContextValue {
  const context = useContext(CoachChatContext);
  if (!context) throw new Error('useCoachChat must be used within CoachChatProvider');
  return context;
}
