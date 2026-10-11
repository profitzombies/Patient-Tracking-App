/**
 * Confirm-to-add follow-ups for the patient's food lists, plus the one-time
 * diet-change acknowledgement.
 *
 * When a signed-in patient tells the coach they dislike, react to, or are
 * allergic to a food, the server (never the model) appends a short offer
 * ("Want me to add broccoli to your dislikes?") to the reply and pushes the
 * confirmation chips. The next turn is routed by the same strict-adjacency
 * contract the meal flows use: the offer must be the closing line of the
 * previous assistant bubble and the patient's answer must be one of the
 * allow-listed taps. Only then is the list item written, through the diet
 * foundation's own service with the coach as entered-by. Allergies take one
 * more step (mild or severe) before anything is written.
 *
 * Detection is deliberately narrow: a missed mention costs nothing (the
 * patient can still add the food in the app), while a false offer about
 * "mornings" would read as a bug.
 */
import { resolvePreferenceKey } from "@workspace/diet-programs";
import { addPreferenceItem, parsePreferenceItem, type DietPatient } from "../diet/service";
import type { DietActor } from "../diet/store";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { DietGrounding, DietListItem } from "./diet-grounding";

export type FollowupList = "dislike" | "sensitivity" | "allergy";

export interface ListMention {
  list: FollowupList;
  /** Clean display label, e.g. "broccoli". */
  label: string;
}

const LIST_NOUN: Record<FollowupList, string> = {
  dislike: "dislikes",
  sensitivity: "sensitivities",
  allergy: "allergies",
};

const NOUN_TO_LIST = new Map<string, FollowupList>(
  (Object.entries(LIST_NOUN) as Array<[FollowupList, string]>).map(([list, noun]) => [noun, list]),
);

/** Server-pushed chip labels for the offer. Allow-listed back on the next turn. */
export const LIST_OFFER_CHIPS: readonly string[] = ["Yes, add it", "No thanks"];
/** Chips under the mild-or-severe question for an allergy. */
export const ALLERGY_SEVERITY_CHIPS: readonly string[] = ["Mild", "Severe"];

// ─── Mention detection ──────────────────────────────────────────────────────

/** Words that end a food phrase. */
const PHRASE_END = String.raw`(?=[.,;!?]|\s+(?:and|or|but|because|since|so|though|although|when|which|that|unless|at|in|on|for|with|anymore|any more|at all|much|very|really|at|too|as well|also|either|lately|unfortunately|sadly|btw|by the way|though)\b|$)`;
/** Up to three words of food phrase, letters/hyphens/apostrophes only. */
const FOOD = String.raw`((?:[a-z][a-z'-]*)(?:\s+[a-z][a-z'-]*){0,2}?)`;

const PATTERNS: Array<{ list: FollowupList; re: RegExp }> = [
  { list: "allergy", re: new RegExp(String.raw`\bi(?:'m| am)\s+(?:\w+\s+)?allergic to\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "allergy", re: new RegExp(String.raw`\bi have an? (?:\w+\s+)?allergy to\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "sensitivity", re: new RegExp(String.raw`\bi(?:'m| am)\s+(?:\w+\s+)?(?:sensitive|intolerant) to\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "sensitivity", re: new RegExp(String.raw`\bi (?:can't|cannot|can not|don't|do not) (?:tolerate|digest|handle|stomach)\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "sensitivity", re: new RegExp(String.raw`\b${FOOD} (?:gives?|makes?) me (?:gassy|gas|bloated|bloating|hives|heartburn|a headache|headaches|a rash|nauseous|nausea|sick|cramps|a stomach ?ache|stomach pain)\b`, "i") },
  { list: "sensitivity", re: new RegExp(String.raw`\b${FOOD} (?:doesn't|does not|don't|do not) (?:agree|sit (?:well|right)) with me${PHRASE_END}`, "i") },
  { list: "sensitivity", re: new RegExp(String.raw`\bi react (?:badly )?to\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "dislike", re: new RegExp(String.raw`\bi (?:really |just |honestly |truly )?(?:hate|dislike|can't stand|cannot stand|despise|loathe)\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "dislike", re: new RegExp(String.raw`\bi(?:'m| am) not a (?:big |huge )?fan of\s+${FOOD}${PHRASE_END}`, "i") },
  { list: "dislike", re: new RegExp(String.raw`\bi (?:really |just |honestly )?(?:don't|do not|dont) (?:like|enjoy|eat|care for|want)\s+${FOOD}${PHRASE_END}`, "i") },
];

/** Leading words that are not part of the food. */
const LEADING = new Set(["the", "a", "an", "any", "some", "much", "all", "eating", "having", "to", "eat", "my", "that", "those", "these", "this"]);
/** Phrases that are never foods (common "I don't like …" objects). */
const NOT_FOOD = new Set([
  "it", "that", "this", "them", "him", "her", "you", "me", "us", "myself", "anything", "everything", "something", "nothing", "stuff", "things",
  "mornings", "morning", "evenings", "nights", "night", "weekends", "mondays", "winter", "summer", "work", "my job", "my boss", "people",
  "exercise", "exercising", "cardio", "running", "walking", "the gym", "gym", "lifting", "weights", "working out", "workouts", "stretching", "yoga",
  "cooking", "meal prep", "prepping", "shopping", "cleaning", "tracking", "logging", "weighing", "weighing in", "the scale", "scale", "numbers", "math",
  "fasting", "dieting", "diets", "waiting", "hunger", "being hungry", "feeling hungry", "cravings", "the cold", "heat", "rain", "mondays", "travel", "flying",
  "how", "when", "where", "what", "why", "way", "taste", "texture", "smell", "idea", "plan", "app", "program", "protocol", "diet", "rules",
  "breakfast", "lunch", "dinner", "snacks", "snacking", "eating", "food", "foods", "meals", "vegetables", "veggies", "fruit", "fruits", "meat", "carbs", "protein", "sugar",
]);
const ING_FOODS = new Set(["pudding", "dressing", "stuffing", "icing", "frosting", "dumpling", "dumplings", "herring", "seasoning", "topping", "toppings", "filling"]);

function cleanPhrase(raw: string): string | null {
  let words = raw.toLowerCase().trim().split(/\s+/);
  if (NOT_FOOD.has(words.join(" "))) return null;
  while (words.length > 0 && LEADING.has(words[0]!)) words = words.slice(1);
  if (words.length === 0 || words.length > 3) return null;
  const phrase = words.join(" ");
  if (NOT_FOOD.has(phrase) || NOT_FOOD.has(words[words.length - 1]!)) return null;
  if (words.some((word) => word.endsWith("ing") && !ING_FOODS.has(word))) return null;
  if (words.some((word) => word.length < 2)) return null;
  return phrase;
}

/**
 * Whether the lists already carry this food: by label containment either
 * way, or because the phrase resolves to a catalog key already on that list
 * ("almonds" when Tree nuts is recorded).
 */
function alreadyListed(list: FollowupList, label: string, lists: readonly DietListItem[]): boolean {
  const needle = label.toLowerCase();
  const resolved = resolvePreferenceKey(list, label);
  return lists.some((item) => {
    const have = item.label.toLowerCase();
    if (have === needle || have.includes(needle) || needle.includes(have)) return true;
    return resolved !== null && item.list === list && item.key === resolved;
  });
}

/** The first list mention in the patient's latest message, if any. */
export function detectListMention(text: string, lists: readonly DietListItem[]): ListMention | null {
  const flat = text.replace(/\s+/g, " ");
  for (const { list, re } of PATTERNS) {
    const match = re.exec(flat);
    if (!match) continue;
    const label = cleanPhrase(match[1] ?? "");
    if (!label) continue;
    if (alreadyListed(list, label, lists)) return null;
    return { list, label };
  }
  return null;
}

// ─── Offer and confirmation ─────────────────────────────────────────────────

/** Server-authored closing question; the next turn's detector keys on it verbatim. */
export function listOfferLine(mention: ListMention): string {
  return `Want me to add ${mention.label} to your ${LIST_NOUN[mention.list]}?`;
}

const OFFER_RE = /Want me to add (.+?) to your (dislikes|sensitivities|allergies)\?\s*$/;
const SEVERITY_RE = /Is your (.+?) allergy mild or severe\?\s*$/;

export function allergySeverityQuestion(label: string): string {
  return `Got it. Is your ${label} allergy mild or severe?`;
}

const YES = new Set(["yes add it", "yes", "yes please", "yeah", "yep", "yup", "sure", "ok", "okay", "please", "add it", "please add it", "go ahead", "do it", "yes do it", "sounds good"]);
const NO = new Set(["no thanks", "no", "nope", "no thank you", "not now", "nah", "leave it", "dont", "no dont"]);
const MILD = new Set(["mild", "its mild", "it is mild", "mild one", "just mild", "pretty mild", "add as mild"]);
const SEVERE = new Set(["severe", "its severe", "it is severe", "serious", "very severe", "add as severe", "bad", "really bad"]);

function normalizeOneTap(text: string): string {
  return text.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

export type ListFollowup =
  | { kind: "add"; list: FollowupList; label: string; severity: "mild" | "severe" | null }
  | { kind: "ask_severity"; label: string }
  | { kind: "declined"; list: FollowupList; label: string };

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/**
 * Strict adjacency: the previous assistant bubble must END with the offer
 * (or the severity question) and the patient's answer must be a known tap.
 */
export function detectListFollowup(history: readonly HistoryEntry[]): ListFollowup | null {
  if (history.length < 2) return null;
  const latest = history[history.length - 1]!;
  const previous = history[history.length - 2]!;
  if (latest.role !== "user" || previous.role !== "assistant") return null;
  const answer = normalizeOneTap(latest.content);

  const severity = SEVERITY_RE.exec(previous.content.trimEnd());
  if (severity) {
    const label = severity[1]!;
    if (MILD.has(answer)) return { kind: "add", list: "allergy", label, severity: "mild" };
    if (SEVERE.has(answer)) return { kind: "add", list: "allergy", label, severity: "severe" };
    if (NO.has(answer)) return { kind: "declined", list: "allergy", label };
    return null;
  }

  const offer = OFFER_RE.exec(previous.content.trimEnd());
  if (!offer) return null;
  const label = offer[1]!;
  const list = NOUN_TO_LIST.get(offer[2]!);
  if (!list) return null;
  if (NO.has(answer)) return { kind: "declined", list, label };
  if (list === "allergy") {
    if (MILD.has(answer)) return { kind: "add", list, label, severity: "mild" };
    if (SEVERE.has(answer)) return { kind: "add", list, label, severity: "severe" };
    if (YES.has(answer)) return { kind: "ask_severity", label };
    return null;
  }
  if (YES.has(answer)) return { kind: "add", list, label, severity: null };
  return null;
}

/** Canned replies for the confirmation turn (no model call). */
export function listAddedReply(list: FollowupList, label: string, severity: "mild" | "severe" | null): string {
  if (list === "allergy") {
    return `Done. ${capitalize(label)} is on your allergies as ${severity ?? "mild"}. I'll keep it out of everything I suggest${severity === "severe" ? ", including anything that may contain it, and your care team has been told" : ""}. You can change or remove it any time in your profile.`;
  }
  if (list === "sensitivity") {
    return `Done. ${capitalize(label)} is on your sensitivities now, so I'll steer clear of it in anything I suggest. You can remove it any time in your profile.`;
  }
  return `Done. ${capitalize(label)} is on your dislikes now. I won't suggest it, though I'll still log it if you eat it. You can remove it any time in your profile.`;
}
export const LIST_DUPLICATE_REPLY = "That one is already on your list, so nothing to add. I'll keep it out of my suggestions.";
export const LIST_DECLINED_REPLY = "No problem, I'll leave your lists as they are.";
export const LIST_WRITE_FAILED_REPLY = "I couldn't save that just now. You can add it under your profile, or ask me again in a bit.";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── The write ──────────────────────────────────────────────────────────────

export const COACH_ENTERED_BY_NAME = "THINNR Coach";

/**
 * Writes the confirmed item through the foundation service (same
 * validation, duplicate rule and severe-allergy care-team notice as the app).
 */
export async function writeConfirmedListItem(args: {
  patientId: string;
  authUserId: string;
  list: FollowupList;
  label: string;
  severity: "mild" | "severe" | null;
  now: Date;
  log?: { error: (obj: unknown, msg?: string) => void };
}): Promise<"created" | "duplicate"> {
  const parsed = parsePreferenceItem({ list: args.list, label: args.label, severity: args.severity ?? undefined });
  if (!parsed.ok) throw new Error(`coach list item rejected: ${parsed.error}`);
  const patient = await loadPatientForWrite(args.patientId);
  const actor: DietActor = { role: "coach", userId: args.authUserId, name: COACH_ENTERED_BY_NAME };
  const result = await addPreferenceItem({ patient, actor, item: parsed.value, now: args.now, log: args.log });
  return result.kind;
}

async function loadPatientForWrite(patientId: string): Promise<DietPatient> {
  const res = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&select=id,provider_id,timezone&limit=1`);
  const rows = res.json;
  if (res.status >= 300 || !Array.isArray(rows) || rows.length === 0) throw new Error(`patient read failed (${res.status})`);
  const row = rows[0] as Record<string, unknown>;
  return { id: String(row.id), provider_id: typeof row.provider_id === "string" ? row.provider_id : null, timezone: typeof row.timezone === "string" ? row.timezone : null };
}

/** Whether this turn should look for a new mention (never while confirming one). */
export function shouldOfferListAdd(diet: DietGrounding | undefined, text: string): ListMention | null {
  if (!diet) return null;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return detectListMention(text, diet.lists);
}
