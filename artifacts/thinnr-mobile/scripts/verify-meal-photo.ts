/**
 * Meal-photo logging regression check (no AI credits spent).
 *
 * Drives the real client pieces behind "Take a photo of your meal" under
 * Node: the real CoachChatContext + lib/coach-api.ts against a scripted SSE
 * transport, the real card parser, the real breakdown-editor math, and the
 * real PatientContext log/save paths (tsconfig.meal-photo.json maps
 * react-native, expo/fetch, async-storage, and expo-haptics to Node stubs).
 *
 * Pins the client half of the meal-photo contract:
 *   1. parseRecipeCardPayload accepts mode "meal" with empty/absent steps —
 *      and ONLY there: recipe/cravings cards still require steps, and the
 *      per-ingredient nutrition a meal card carries survives parsing.
 *   2. sendPhoto(photo, "meal") sends the image + photoKind "meal" on the
 *      request tail ONLY, shows the meal replay text, keeps the photo (with
 *      its kind) in client state, and registers the arriving meal card with
 *      the patient's OWN photo as its picture (no AI image generation).
 *      Follow-up requests replay the turn as text with no image/photoKind
 *      anywhere. sendPhoto without a kind sends NO photoKind at all (the
 *      server looks at the photo and routes it) with the generic replay
 *      text; a photo that OPENS the session hides the seeded greeting from
 *      the transcript while the request history still carries it.
 *   3. offersMealPhotoRetake: true exactly when the LATEST message is a
 *      finished (done or error) reply to a meal-photo turn and nothing is
 *      streaming — false mid-stream, false after a later text turn, false
 *      for menu turns. A kindless turn earns the chip exactly when its
 *      reply came back with a meal-mode card (the server routed it to the
 *      meal pipeline).
 *   4. retry() on a failed meal turn re-attaches the SAME image and
 *      photoKind "meal" so the retry reaches the meal pipeline again.
 *      Meal-slot context rides every body: the provider's injected clock
 *      stamps localTime "14:05" on each request, an entry point that pins a
 *      slot sends mealSlot (kept in client state), and a retry re-sends the
 *      SAME pin.
 *   5. The breakdown-editor math works on the meal shape (all rows editable):
 *      stepping an item re-scales from the ORIGINAL baseline (two
 *      adjustments never compound) and totals recompute as base + delta.
 *   6. PatientContext.addSavedRecipe accepts the meal-mode recipe (empty
 *      steps, minutes 0, patient photo, "meal photo" tag) — the Library's
 *      data source — and addEntry lands the adjusted meal in the diary for
 *      its date with the adjustment list preserved.
 *   7. The label flow: an explicit label turn sends photoKind "label" and
 *      shows its replay text; the streamed labelDraft is HELD until the
 *      reply finalizes, then send() resolves the name conversation
 *      client-side (no network): Title Case proposal → confirm chips →
 *      client-built "food" card (draft + confirmed name, which never
 *      round-trips through the model) → rename by chip, by typing, or from
 *      the card via beginLabelRename.
 *   8. Kindless label routing: the route announcement stamps the turn and a
 *      retry names "label" explicitly; label turns never offer the meal
 *      retake chip; a new photo abandons a pending flow; an errored label
 *      turn drops the held draft; stop() keeps it when text was shown.
 *   9. Add-from-card integration: buildCustomFoodFromLabel +
 *      buildLabelDiaryEntry run the SAME paths as Add Food (custom food in
 *      "My Foods", editable like any other, diary entry for the chosen
 *      slot), and markLabelFoodAdded freezes the card payload.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:meal-photo
 */
import React, { act } from 'react';

import {
  CoachChatProvider,
  GREETING_MESSAGE_ID,
  LABEL_CARD_INTRO,
  LABEL_CONFIRM_CREATE,
  LABEL_CONFIRM_FIX,
  LABEL_PHOTO_MESSAGE_TEXT,
  LABEL_RENAME_ASK,
  MEAL_PHOTO_MESSAGE_TEXT,
  MENU_PHOTO_MESSAGE_TEXT,
  PHOTO_MESSAGE_TEXT,
  labelConfirmText,
  labelRenamedAck,
  offersMealPhotoRetake,
  useCoachChat,
  type CoachMessage,
} from '../context/CoachChatContext';
import { PatientProvider, usePatient } from '../context/PatientContext';
import { parseRecipeCardPayload } from '../lib/ai-recipe';
import {
  buildCustomFoodFromLabel,
  buildLabelDiaryEntry,
  parseLabelFoodCardPayload,
} from '../lib/label-food';
import { toTitleCase } from '../lib/title-case';
import {
  adjustedPerServing,
  applyAdjustments,
  totalsForQuantity,
} from '../data/ingredient-nutrition';
import {
  TODAY_KEY,
  type MealLogEntry,
  type RecipeIngredient,
  type SavedRecipe,
} from '../data/patient-data';

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

function assertEqual(label: string, actual: string | number, expected: string | number) {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

function finish(): never {
  if (failures > 0) {
    console.error(`\n✗ meal photo check: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ meal photo check: ${checks} checks passed`);
  process.exit(0);
}

// ── Scripted SSE transport (same pattern as verify-coach-stop.ts) ────────────

interface RequestMessage {
  role: string;
  content: string;
  image?: string;
  photoKind?: string;
}

interface ScriptedSse {
  requestBody: { messages?: RequestMessage[]; localTime?: string; mealSlot?: string };
  emit(payload: Record<string, unknown>): void;
  close(): void;
}

const opened: ScriptedSse[] = [];
const encoder = new TextEncoder();

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function scriptedFetch(
  _input: unknown,
  init?: { body?: unknown; signal?: AbortSignal | null },
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(abortError());

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let dead = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const scripted: ScriptedSse = {
    requestBody: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    emit(payload) {
      if (dead) return;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    },
    close() {
      if (dead) return;
      dead = true;
      controller.close();
    },
  };

  if (signal) {
    signal.addEventListener('abort', () => {
      if (dead) return;
      dead = true;
      controller.error(abortError());
    });
  }

  opened.push(scripted);
  return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
}

function takeStream(label: string): ScriptedSse {
  const stream = opened.shift();
  if (!stream) {
    fail(`${label}: expected the client to have opened a coach stream`);
    finish();
  }
  return stream;
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function settle() {
  await tick();
  await tick();
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Probes ────────────────────────────────────────────────────────────────────

type Chat = ReturnType<typeof useCoachChat>;
let chat!: Chat;
function ChatProbe(): null {
  chat = useCoachChat();
  return null;
}

type Patient = ReturnType<typeof usePatient>;
let patient!: Patient;
function PatientProbe(): null {
  patient = usePatient();
  return null;
}

const tailMessage = () => chat.messages[chat.messages.length - 1];

async function actSettle(mutate?: () => void): Promise<void> {
  await act(async () => {
    mutate?.();
    await settle();
  });
}

async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  checks += 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      fail(`${label}: condition not met within ${timeoutMs}ms`);
      finish();
    }
    await act(async () => {
      await sleep(8);
    });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The server's meal card: one serving, nothing to cook, exact item sums. */
const MEAL_CARD_PAYLOAD = {
  id: 'meal_test_1',
  mode: 'meal',
  // The real server Title Cases created names at payload assembly.
  name: 'Grilled Chicken with Sweet Potatoes',
  description: 'Grilled chicken breast with a side of roasted sweet potatoes.',
  meal: 'dinner',
  minutes: 0,
  servings: 1,
  calories: 460,
  protein: 53,
  carbs: 41,
  fat: 7,
  ingredients: [
    {
      amount: 6,
      unit: 'oz',
      name: 'grilled chicken breast',
      nutrition: { calories: 280, protein: 50, carbs: 0, fat: 6 },
    },
    {
      amount: 1,
      unit: 'cup',
      name: 'roasted sweet potatoes',
      nutrition: { calories: 180, protein: 3, carbs: 41, fat: 1 },
    },
  ],
  steps: [] as string[],
};

const MEAL_REPLY_TEXT = [
  "That's a solid plate, lean protein and a real vegetable side.",
  'Grilled chicken breast: about 6 oz · est. 280 cal\nRoasted sweet potatoes: about 1 cup · est. 180 cal',
  'These amounts are my best read of the photo. Open the meal card below to fine-tune them, then log the meal or save it for next time. And if I misread your plate, just retake the photo.',
].join('\n\n');

const MEAL_PHOTO = { uri: 'file:///meal-photo.jpg', width: 800, height: 600 };
const RETRY_PHOTO = { uri: 'file:///meal-retake.jpg', width: 800, height: 600 };
const MENU_PHOTO = { uri: 'file:///menu-photo.jpg', width: 800, height: 600 };

/** The server's validated Nutrition Facts read for one label photo. */
const LABEL_DRAFT = {
  id: 'label_test_1',
  servingSize: '2/3 cup (55g)',
  servingsPerContainer: 8,
  calories: 230,
  protein: 8,
  carbs: 37,
  fat: 8,
  fiber: 4,
  sugar: 12,
  sodium: 160,
  suggestedSlot: 'lunch',
};

const LABEL_REPLY_TEXT = [
  'Nice, a label I can actually read.',
  'Per serving (2/3 cup (55g)): 230 cal · 8g protein · 37g carbs · 8g fat\nServings per container: 8\nAlso printed: 4g fiber · 12g sugar · 160mg sodium',
  "One thing the label never tells me is the name. Type what this food is called, brand and all, and I'll set it up as a food you can log anytime.",
].join('\n\n');

const LABEL_PHOTO = { uri: 'file:///label-photo.jpg', width: 800, height: 600 };
const LABEL_KINDLESS_PHOTO = { uri: 'file:///label-kindless.jpg', width: 800, height: 600 };

async function main() {
  process.env.EXPO_PUBLIC_DOMAIN = 'meal-photo.internal';
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = scriptedFetch as unknown as typeof fetch;

  // The react-native stub pins Platform.OS to 'web', so PatientContext
  // persists through localStorage — give Node one.
  if (!globalThis.localStorage) {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key) : null),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    };
  }

  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    if (typeof args[0] === 'string' && args[0].includes('stream ended without a done event')) return;
    // The typed-out reveal runs on REAL timers; a tick can land between the
    // suite's act() slices, which React flags as an un-wrapped update. The
    // very next act() flushes it, so the warning is expected noise here.
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
    realConsoleError(...args);
  };
  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create: (el: React.ReactElement) => { unmount(): void } };
    create?: (el: React.ReactElement) => { unmount(): void };
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');

  // ── 1. Card parser: meal mode is the only stepless shape ──────────────────
  {
    const parsed = parseRecipeCardPayload(MEAL_CARD_PAYLOAD);
    assert('meal payload with empty steps parses', parsed !== null);
    if (parsed) {
      assertEqual('meal payload keeps mode "meal"', parsed.mode, 'meal');
      assertEqual('meal payload keeps minutes 0', parsed.minutes, 0);
      assertEqual('meal payload keeps one serving', parsed.servings, 1);
      assertEqual('meal payload keeps empty steps', parsed.steps.length, 0);
      assertEqual(
        'meal payload keeps per-ingredient nutrition',
        parsed.ingredients[0].nutrition?.calories ?? -1,
        280,
      );
    }

    const noSteps: Record<string, unknown> = { ...MEAL_CARD_PAYLOAD };
    delete noSteps.steps;
    const parsedNoSteps = parseRecipeCardPayload(noSteps);
    assert(
      'meal payload with ABSENT steps parses to empty steps',
      parsedNoSteps !== null && parsedNoSteps.steps.length === 0,
    );

    assert(
      'recipe payload with empty steps is still rejected',
      parseRecipeCardPayload({ ...MEAL_CARD_PAYLOAD, mode: 'recipe' }) === null,
    );
    assert(
      'recipe payload with steps still parses (regression)',
      parseRecipeCardPayload({
        ...MEAL_CARD_PAYLOAD,
        mode: 'recipe',
        minutes: 20,
        steps: ['Grill the chicken.'],
      }) !== null,
    );
    assert(
      'meal payload without ingredients is rejected',
      parseRecipeCardPayload({ ...MEAL_CARD_PAYLOAD, ingredients: [] }) === null,
    );
  }

  // ── 2. Coach chat: the meal photo turn ─────────────────────────────────────
  // Fixed wall clock injected into the provider: 14:05 is lunch territory,
  // so every request body must carry localTime "14:05". Never the real
  // clock — that would make these checks drift by time of day.
  const FIXED_NOW = new Date(2026, 7, 26, 14, 5, 0);
  let coachTree!: { unmount(): void };
  await act(async () => {
    coachTree = TestRenderer.create!(
      React.createElement(
        CoachChatProvider,
        { now: () => FIXED_NOW },
        React.createElement(ChatProbe),
      ),
    );
    await settle();
  });

  // 2a. sendPhoto(…, 'meal'): meal replay text, kept photo+kind, tail-only
  // image+photoKind, and the arriving card registers with the patient photo.
  await actSettle(() => {
    chat.sendPhoto(MEAL_PHOTO, 'meal');
  });
  assert('sendPhoto(meal) locks the chat while streaming', chat.isStreaming === true);
  assert(
    'no retake chip while the meal reply is still streaming',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === false,
  );
  {
    // The photo opened this session: the seeded greeting hides from the
    // transcript but stays in state for request replay.
    const seededGreeting = chat.messages[0];
    assert(
      'a photo-opened session hides the seeded greeting',
      seededGreeting?.id === GREETING_MESSAGE_ID && seededGreeting?.hidden === true,
    );
  }
  const mealTurn = chat.messages[chat.messages.length - 2];
  assertEqual('the meal turn shows the meal replay text', mealTurn.text, MEAL_PHOTO_MESSAGE_TEXT);
  assertEqual('the meal turn keeps the photo in client state', mealTurn.photo?.uri ?? '', MEAL_PHOTO.uri);
  assertEqual('the meal turn keeps the photo kind', mealTurn.photo?.kind ?? '', 'meal');

  const s1 = takeStream('meal turn');
  {
    const msgs = s1.requestBody.messages ?? [];
    const mealTail = msgs[msgs.length - 1];
    assert('the meal request tail is the user turn', mealTail?.role === 'user');
    assertEqual('the meal request tail carries the replay text', mealTail?.content ?? '', MEAL_PHOTO_MESSAGE_TEXT);
    assertEqual('the meal request tail carries the image', mealTail?.image ?? '', MEAL_PHOTO.uri);
    assertEqual('the meal request tail carries photoKind "meal"', mealTail?.photoKind ?? '', 'meal');
    assert(
      'no earlier message in the meal request carries an image or photoKind',
      msgs.slice(0, -1).every(m => m.image === undefined && m.photoKind === undefined),
    );
    assert(
      'the hidden greeting still opens the request history',
      msgs[0]?.role === 'assistant' && (msgs[0]?.content ?? '').length > 0,
    );
    assertEqual(
      'the meal request carries the injected local time',
      s1.requestBody.localTime ?? '',
      '14:05',
    );
    assert('an unpinned meal turn sends no mealSlot', s1.requestBody.mealSlot === undefined);
  }

  await actSettle(() => {
    s1.emit({ content: MEAL_REPLY_TEXT });
    s1.emit({ card: { kind: 'recipe', payload: MEAL_CARD_PAYLOAD } });
    s1.emit({ done: true });
    s1.close();
  });
  await waitUntil(
    'the meal reply reveals fully and finalizes',
    () => tailMessage().status === 'done' && tailMessage().text === MEAL_REPLY_TEXT,
  );
  assert('the meal reply carries the card', tailMessage().card?.kind === 'recipe');

  {
    const suggestion = chat.getRecipeSuggestion('meal_test_1');
    assert('the meal card registers as a session suggestion', suggestion !== undefined);
    assertEqual('the registered suggestion is meal mode', suggestion?.mode ?? '', 'meal');
    assertEqual(
      "the registered suggestion keeps the patient's own photo",
      suggestion?.photoUri ?? '',
      MEAL_PHOTO.uri,
    );
    assertEqual('the registered suggestion has nothing to cook', suggestion?.steps.length ?? -1, 0);
  }
  assert(
    'the finished meal reply offers the retake chip',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === true,
  );

  // 2b. A follow-up send replays the meal turn as TEXT ONLY, and the retake
  // chip leaves with the newer reply.
  await actSettle(() => {
    chat.send('Thanks, that looks right.');
  });
  const s2 = takeStream('meal follow-up');
  {
    const msgs = s2.requestBody.messages ?? [];
    assert(
      'the follow-up request replays the meal turn as its fixed text',
      msgs.some(m => m.role === 'user' && m.content === MEAL_PHOTO_MESSAGE_TEXT),
    );
    assert(
      'no message in the follow-up request carries an image or photoKind',
      msgs.every(m => m.image === undefined && m.photoKind === undefined),
    );
    assertEqual(
      'a plain text send also carries the injected local time',
      s2.requestBody.localTime ?? '',
      '14:05',
    );
  }
  await actSettle(() => {
    s2.emit({ content: 'Anytime — logged and noted.' });
    s2.emit({ done: true });
    s2.close();
  });
  await waitUntil('the follow-up reply finalizes', () => tailMessage().status === 'done');
  assert(
    'the retake chip is gone once a newer text reply is latest',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === false,
  );

  // 2c. A failed meal turn offers retake, and retry() re-attaches the SAME
  // image with photoKind "meal".
  await actSettle(() => {
    chat.sendPhoto(RETRY_PHOTO, 'meal');
  });
  const s3 = takeStream('meal failure');
  await actSettle(() => {
    s3.emit({ error: 'The coach hit a snag reading that photo.' });
    s3.close();
  });
  await waitUntil('the failed meal turn shows the error bubble', () => tailMessage().status === 'error');
  assert(
    'a failed meal reply still offers the retake chip',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === true,
  );

  const errorId = tailMessage().id;
  await actSettle(() => {
    chat.retry(errorId);
  });
  const s4 = takeStream('meal retry');
  {
    const msgs = s4.requestBody.messages ?? [];
    const retryTail = msgs[msgs.length - 1];
    assertEqual('retry re-sends the same meal photo on the tail', retryTail?.image ?? '', RETRY_PHOTO.uri);
    assertEqual('retry re-attaches photoKind "meal"', retryTail?.photoKind ?? '', 'meal');
    assertEqual('retry keeps the meal replay text', retryTail?.content ?? '', MEAL_PHOTO_MESSAGE_TEXT);
    assertEqual('retry stamps a fresh local time', s4.requestBody.localTime ?? '', '14:05');
    assert('an unpinned retry sends no mealSlot', s4.requestBody.mealSlot === undefined);
  }
  await actSettle(() => {
    s4.emit({ content: 'Take two — same plate, fresh eyes.' });
    s4.emit({ done: true });
    s4.close();
  });
  await waitUntil('the retried meal turn completes', () => tailMessage().status === 'done');

  // 2d. sendPhoto WITHOUT a kind: generic replay text, NO photoKind on the
  // tail (the server looks at the photo and routes it), kind unset in
  // state until the server's route announcement stamps it; a menu-routed
  // reply earns no retake chip.
  await actSettle(() => {
    chat.sendPhoto(MENU_PHOTO);
  });
  const kindlessTurn = chat.messages[chat.messages.length - 2];
  assertEqual('a kindless sendPhoto shows the generic replay text', kindlessTurn.text, PHOTO_MESSAGE_TEXT);
  assert('a kindless sendPhoto keeps kind unset in state', kindlessTurn.photo?.kind === undefined);
  const s5 = takeStream('kindless turn');
  {
    const msgs = s5.requestBody.messages ?? [];
    const kindlessTail = msgs[msgs.length - 1];
    assertEqual('the kindless request tail carries the image', kindlessTail?.image ?? '', MENU_PHOTO.uri);
    assert('the kindless request tail carries NO photoKind', kindlessTail?.photoKind === undefined);
  }
  await actSettle(() => {
    s5.emit({ photoKind: 'menu' });
    s5.emit({ content: 'The grill section is your friend here.' });
    s5.emit({ done: true });
    s5.close();
  });
  await waitUntil('the kindless (menu-routed) reply finalizes', () => tailMessage().status === 'done');
  assert(
    'a kindless reply without a meal card offers no retake chip',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === false,
  );
  assertEqual(
    "the route announcement stamped 'menu' onto the photo turn",
    chat.messages.find(m => m.id === kindlessTurn.id)?.photo?.kind ?? '',
    'menu',
  );

  // 2e. A kindless turn the SERVER routed to the meal pipeline (the reply
  // carries a meal-mode card) offers the retake chip, and the registered
  // suggestion keeps the patient's own photo. Deliberately NO route
  // announcement here — the meal card alone must be tell enough, covering
  // a reply whose announcement was lost.
  const PLATE_PHOTO = { uri: 'file:///plate-photo.jpg', width: 800, height: 600 };
  await actSettle(() => {
    chat.sendPhoto(PLATE_PHOTO);
  });
  const s6 = takeStream('kindless plate turn');
  await actSettle(() => {
    s6.emit({ content: MEAL_REPLY_TEXT });
    s6.emit({ card: { kind: 'recipe', payload: { ...MEAL_CARD_PAYLOAD, id: 'meal_test_2' } } });
    s6.emit({ done: true });
    s6.close();
  });
  await waitUntil(
    'the kindless (meal-routed) reply finalizes with its card',
    () => tailMessage().status === 'done' && tailMessage().card !== undefined,
  );
  assert(
    'a meal-mode card on a kindless turn offers the retake chip',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === true,
  );
  assertEqual(
    "a kindless meal card still keeps the patient's own photo",
    chat.getRecipeSuggestion('meal_test_2')?.photoUri ?? '',
    PLATE_PHOTO.uri,
  );

  // 2f. A kindless turn whose route the SERVER announced retries on the
  // SAME route: the announcement stamps the photo turn, and retry() names
  // the stamped kind explicitly instead of letting the server triage the
  // same photo again.
  const PLATE_RETRY_PHOTO = { uri: 'file:///plate-retry.jpg', width: 800, height: 600 };
  await actSettle(() => {
    chat.sendPhoto(PLATE_RETRY_PHOTO);
  });
  const stampTurnId = chat.messages[chat.messages.length - 2].id;
  const s6b = takeStream('kindless stamped failure');
  {
    const msgs = s6b.requestBody.messages ?? [];
    assert(
      'the stamped-failure send carries NO photoKind',
      msgs[msgs.length - 1]?.photoKind === undefined,
    );
  }
  await actSettle(() => {
    s6b.emit({ photoKind: 'meal' });
    s6b.emit({ error: 'The coach hit a snag reading that photo.' });
    s6b.close();
  });
  await waitUntil(
    'the stamped kindless turn shows the error bubble',
    () => tailMessage().status === 'error',
  );
  assertEqual(
    "the route announcement stamped 'meal' before the failure",
    chat.messages.find(m => m.id === stampTurnId)?.photo?.kind ?? '',
    'meal',
  );
  assert(
    'a stamped meal turn offers the retake chip on failure',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === true,
  );
  const stampedErrorId = tailMessage().id;
  await actSettle(() => {
    chat.retry(stampedErrorId);
  });
  const s6c = takeStream('stamped kindless retry');
  {
    const msgs = s6c.requestBody.messages ?? [];
    const stampedTail = msgs[msgs.length - 1];
    assertEqual('the stamped retry names the announced route', stampedTail?.photoKind ?? '', 'meal');
    assertEqual('the stamped retry re-sends the same photo', stampedTail?.image ?? '', PLATE_RETRY_PHOTO.uri);
    assertEqual('the stamped retry keeps the generic replay text', stampedTail?.content ?? '', PHOTO_MESSAGE_TEXT);
  }
  await actSettle(() => {
    s6c.emit({ content: 'Take two, same plate.' });
    s6c.emit({ done: true });
    s6c.close();
  });
  await waitUntil('the stamped retry completes', () => tailMessage().status === 'done');

  // 2g. An EXPLICIT menu kind still sends photoKind "menu" (API regression).
  await actSettle(() => {
    chat.sendPhoto(MENU_PHOTO, 'menu');
  });
  const explicitMenuTurn = chat.messages[chat.messages.length - 2];
  assertEqual('an explicit menu turn shows the menu replay text', explicitMenuTurn.text, MENU_PHOTO_MESSAGE_TEXT);
  const s7 = takeStream('explicit menu turn');
  {
    const msgs = s7.requestBody.messages ?? [];
    assertEqual(
      'the explicit menu tail carries photoKind "menu"',
      msgs[msgs.length - 1]?.photoKind ?? '',
      'menu',
    );
  }
  await actSettle(() => {
    s7.emit({ content: 'Grilled fish, dressing on the side.' });
    s7.emit({ done: true });
    s7.close();
  });
  await waitUntil('the explicit menu reply finalizes', () => tailMessage().status === 'done');

  // 2h. A capture flow that already knows its diary slot (groundwork for the
  // diary's per-meal camera) pins it: the pin rides the request body, is
  // kept in client state, and a retry re-sends the SAME pin.
  const PINNED_PHOTO = { uri: 'file:///pinned-dinner.jpg', width: 800, height: 600 };
  await actSettle(() => {
    chat.sendPhoto(PINNED_PHOTO, 'meal', { mealSlot: 'dinner' });
  });
  const pinnedTurn = chat.messages[chat.messages.length - 2];
  assertEqual(
    'the pinned turn keeps the slot in client state',
    pinnedTurn.photo?.mealSlot ?? '',
    'dinner',
  );
  const s8 = takeStream('pinned meal turn');
  assertEqual('the pinned turn sends mealSlot "dinner"', s8.requestBody.mealSlot ?? '', 'dinner');
  assertEqual(
    'the pinned turn still carries the local time',
    s8.requestBody.localTime ?? '',
    '14:05',
  );
  await actSettle(() => {
    s8.emit({ error: 'The coach hit a snag reading that photo.' });
    s8.close();
  });
  await waitUntil('the pinned turn shows the error bubble', () => tailMessage().status === 'error');
  const pinnedErrorId = tailMessage().id;
  await actSettle(() => {
    chat.retry(pinnedErrorId);
  });
  const s9 = takeStream('pinned meal retry');
  assertEqual('the retry re-sends the SAME pinned slot', s9.requestBody.mealSlot ?? '', 'dinner');
  {
    const msgs = s9.requestBody.messages ?? [];
    assertEqual(
      'the pinned retry re-sends the same photo',
      msgs[msgs.length - 1]?.image ?? '',
      PINNED_PHOTO.uri,
    );
  }
  await actSettle(() => {
    s9.emit({ content: 'Logged for dinner, nice plate.' });
    s9.emit({ done: true });
    s9.close();
  });
  await waitUntil('the pinned retry completes', () => tailMessage().status === 'done');

  assertEqual('every coach stream was accounted for', opened.length, 0);
  coachTree.unmount();

  // ── 3. Breakdown-editor math on the meal shape ─────────────────────────────
  {
    const ingredients = MEAL_CARD_PAYLOAD.ingredients as RecipeIngredient[];
    const base = { calories: 460, protein: 53, carbs: 41, fat: 7 };

    assert(
      'every meal row is editable (positive amount + nutrition)',
      applyAdjustments(ingredients, []).every(view => view.editable),
    );

    // Step the chicken 6 oz → 7 oz: the row scales from its ORIGINAL 6 oz.
    const up = [{ index: 0, amount: 7, unit: 'oz' }];
    const upViews = applyAdjustments(ingredients, up);
    assert('the stepped row is marked adjusted', upViews[0].adjusted === true);
    assertEqual(
      'the stepped row scales its calories from the original baseline',
      Math.round(upViews[0].nutrition?.calories ?? -1),
      327, // 280 × 7⁄6
    );
    const upTotals = totalsForQuantity(adjustedPerServing(base, ingredients, up), 1);
    assertEqual('meal totals recompute as base + delta (calories)', upTotals.calories, 507);
    assertEqual('meal totals recompute as base + delta (protein)', upTotals.protein, 61);
    assertEqual('untouched macros stay put (carbs)', upTotals.carbs, 41);
    assertEqual('meal totals recompute as base + delta (fat)', upTotals.fat, 8);

    // A second adjustment on the same row REPLACES the first — scaling stays
    // anchored to the original 6 oz, never compounding 7 → 5.
    const down = [
      { index: 0, amount: 7, unit: 'oz' },
      { index: 0, amount: 5, unit: 'oz' },
    ];
    const downViews = applyAdjustments(ingredients, down);
    assertEqual(
      'a later adjustment replaces the earlier one (no compounding)',
      Math.round(downViews[0].nutrition?.calories ?? -1),
      233, // 280 × 5⁄6 — NOT 280 × 7⁄6 × 5⁄7 of the adjusted value
    );
    const downTotals = totalsForQuantity(adjustedPerServing(base, ingredients, down), 1);
    assertEqual('totals follow the replacing adjustment', downTotals.calories, 413);

    // No adjustments → exactly the stated totals (no rounding jitter).
    const untouched = totalsForQuantity(adjustedPerServing(base, ingredients, []), 1);
    assertEqual('unadjusted meal totals are exactly the card totals', untouched.calories, 460);
  }

  // ── 4. PatientContext: log to diary + save as recipe ──────────────────────
  let patientTree!: { unmount(): void };
  await act(async () => {
    patientTree = TestRenderer.create!(
      React.createElement(PatientProvider, null, React.createElement(PatientProbe)),
    );
    await settle();
  });
  await waitUntil('patient state hydrates', () => patient !== undefined && patient.hydrated);

  let saved: SavedRecipe | undefined;
  await act(async () => {
    saved = await patient.addSavedRecipe({
      name: MEAL_CARD_PAYLOAD.name,
      meal: 'dinner',
      tags: ['coach', 'meal photo'],
      minutes: 0,
      servings: 1,
      calories: 460,
      protein: 53,
      carbs: 41,
      fat: 7,
      description: MEAL_CARD_PAYLOAD.description,
      ingredients: MEAL_CARD_PAYLOAD.ingredients as RecipeIngredient[],
      steps: [],
      source: 'coach',
      mode: 'meal',
      savedAt: new Date().toISOString(),
      photoUri: MEAL_PHOTO.uri,
    });
  });
  assert('addSavedRecipe returns the saved meal', saved !== undefined);
  {
    const inLibrary = patient.savedRecipes.find(r => r.id === saved?.id);
    assert('the saved meal appears in the Library data source', inLibrary !== undefined);
    assertEqual('the saved meal keeps mode "meal"', inLibrary?.mode ?? '', 'meal');
    assertEqual('the saved meal keeps empty steps', inLibrary?.steps.length ?? -1, 0);
    assertEqual('the saved meal keeps minutes 0', inLibrary?.minutes ?? -1, 0);
    assert('the saved meal is tagged "meal photo"', inLibrary?.tags.includes('meal photo') === true);
    assertEqual("the saved meal keeps the patient's photo", inLibrary?.photoUri ?? '', MEAL_PHOTO.uri);
  }

  // Log the ADJUSTED meal (chicken stepped to 7 oz) to today's diary; the
  // entry stores the recomputed totals plus the adjustment list, exactly as
  // the ai-recipe screen logs it.
  const DATE_KEY = '2026-08-26';
  const adjustments = [{ index: 0, amount: 7, unit: 'oz' }];
  const logged = totalsForQuantity(
    adjustedPerServing(
      { calories: 460, protein: 53, carbs: 41, fat: 7 },
      MEAL_CARD_PAYLOAD.ingredients as RecipeIngredient[],
      adjustments,
    ),
    1,
  );
  await act(async () => {
    await patient.addEntry({
      dateKey: DATE_KEY,
      meal: 'dinner',
      kind: 'recipe',
      refId: saved!.id,
      name: MEAL_CARD_PAYLOAD.name,
      detail: '1 serving · from your photo',
      quantity: 1,
      calories: logged.calories,
      protein: logged.protein,
      carbs: logged.carbs,
      fat: logged.fat,
      adjustments,
    });
  });
  {
    const entry: MealLogEntry | undefined = patient
      .entriesForDate(DATE_KEY)
      .find(e => e.refId === saved?.id);
    assert('the logged meal lands in the diary for its date', entry !== undefined);
    assertEqual('the logged entry stores the adjusted calories', entry?.calories ?? -1, 507);
    assertEqual('the logged entry stores the adjusted protein', entry?.protein ?? -1, 61);
    assertEqual('the logged entry keeps the adjustment list', entry?.adjustments?.length ?? -1, 1);
    assertEqual('the logged entry links back to the saved meal', entry?.refId ?? '', saved?.id ?? '');
  }
  patientTree.unmount();

  // ── 5. The label flow: photo → read → name → confirm → card → rename ──────
  // One tree carries BOTH providers so the Add integration later drives the
  // same context pair the food card component sees.
  let labelTree!: { unmount(): void };
  await act(async () => {
    labelTree = TestRenderer.create!(
      React.createElement(
        PatientProvider,
        null,
        React.createElement(PatientProbe),
        React.createElement(
          CoachChatProvider,
          { now: () => FIXED_NOW },
          React.createElement(ChatProbe),
        ),
      ),
    );
    await settle();
  });
  await waitUntil(
    'patient state hydrates for the label flow',
    () => patient !== undefined && patient.hydrated,
  );

  // 5a. Explicit label turn: replay text, kept kind, tail-only photoKind
  // "label", and the streamed draft opens the name conversation only once
  // the reply finalizes.
  await actSettle(() => {
    chat.sendPhoto(LABEL_PHOTO, 'label');
  });
  const labelTurn = chat.messages[chat.messages.length - 2];
  assertEqual('the label turn shows the label replay text', labelTurn.text, LABEL_PHOTO_MESSAGE_TEXT);
  assertEqual('the label turn keeps the photo kind', labelTurn.photo?.kind ?? '', 'label');
  const sL1 = takeStream('label turn');
  {
    const msgs = sL1.requestBody.messages ?? [];
    const tail = msgs[msgs.length - 1];
    assertEqual('the label request tail carries the image', tail?.image ?? '', LABEL_PHOTO.uri);
    assertEqual('the label request tail carries photoKind "label"', tail?.photoKind ?? '', 'label');
    assertEqual('the label request carries the injected local time', sL1.requestBody.localTime ?? '', '14:05');
  }
  await actSettle(() => {
    sL1.emit({ content: LABEL_REPLY_TEXT });
    sL1.emit({ labelDraft: LABEL_DRAFT });
  });
  assert('the held draft opens no flow while streaming', chat.labelFlow === null);
  await actSettle(() => {
    sL1.emit({ done: true });
    sL1.close();
  });
  await waitUntil(
    'the label reply reveals fully and finalizes',
    () => tailMessage().status === 'done' && tailMessage().text === LABEL_REPLY_TEXT,
  );
  await waitUntil(
    'the finalized label reply opens the name conversation',
    () => chat.labelFlow?.phase === 'awaiting-name',
  );
  assertEqual('the flow holds the draft calories', chat.labelFlow?.draft.calories ?? -1, 230);
  assertEqual('the flow holds the suggested slot', chat.labelFlow?.draft.suggestedSlot ?? '', 'lunch');
  assert(
    'a label reply never offers the meal retake chip',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === false,
  );
  assert(
    'the name ask ends the reply without fallback chips',
    !tailMessage().text.trimEnd().endsWith('?') && tailMessage().quickReplies === undefined,
  );

  // 5b. The patient names the product: resolved CLIENT-SIDE (no stream), the
  // proposal is Title Case, and the confirm bubble carries its two chips.
  await actSettle(() => {
    chat.send('overnight muesli original');
  });
  assertEqual('the name reply opens NO coach stream', opened.length, 0);
  {
    const userBubble = chat.messages[chat.messages.length - 2];
    const confirm = tailMessage();
    assertEqual('the typed name shows as a user bubble', userBubble.text, 'overnight muesli original');
    assertEqual('the confirm bubble proposes the Title Case name', confirm.text, labelConfirmText('Overnight Muesli Original'));
    assert('the confirm bubble ends with a question', confirm.text.trimEnd().endsWith('?'));
    assert('the confirm bubble is already done', confirm.status === 'done');
    assertEqual('the confirm bubble replies to the name turn', confirm.replyToId ?? '', userBubble.id);
    assertEqual(
      'the confirm bubble carries the two label chips',
      (confirm.quickReplies ?? []).join('|'),
      `${LABEL_CONFIRM_CREATE}|${LABEL_CONFIRM_FIX}`,
    );
  }
  assertEqual('the flow moves to confirming', chat.labelFlow?.phase ?? '', 'confirming');

  // 5c. "Fix the name" loops back to the ask.
  await actSettle(() => {
    chat.send(LABEL_CONFIRM_FIX);
  });
  assertEqual('the fix chip opens NO coach stream', opened.length, 0);
  assertEqual('the fix chip re-asks for the name', tailMessage().text, LABEL_RENAME_ASK);
  assertEqual('the flow returns to awaiting-name', chat.labelFlow?.phase ?? '', 'awaiting-name');

  // 5d. A fresh name re-confirms; deliberate inner caps survive Title Case.
  await actSettle(() => {
    chat.send('PB&J overnight muesli');
  });
  assertEqual(
    'the corrected name reconfirms with inner caps intact',
    tailMessage().text,
    labelConfirmText('PB&J Overnight Muesli'),
  );
  assertEqual('the flow is confirming again', chat.labelFlow?.phase ?? '', 'confirming');

  // 5e. Typing during confirm (not a chip) is treated as a correction.
  await actSettle(() => {
    chat.send('overnight muesli jar');
  });
  assertEqual(
    'typed text during confirm becomes the new proposal',
    tailMessage().text,
    labelConfirmText('Overnight Muesli Jar'),
  );

  // 5f. "Create the food" builds the card from the HELD draft + name.
  await actSettle(() => {
    chat.send(LABEL_CONFIRM_CREATE);
  });
  assertEqual('the create chip opens NO coach stream', opened.length, 0);
  const cardMessage = tailMessage();
  assertEqual('the card bubble carries the intro line', cardMessage.text, LABEL_CARD_INTRO);
  assert('the card intro does not end in a question', !LABEL_CARD_INTRO.trimEnd().endsWith('?'));
  assert('the card bubble carries a food card', cardMessage.card?.kind === 'food');
  assert('creating the food closes the flow', chat.labelFlow === null);
  const cardPayload = parseLabelFoodCardPayload(cardMessage.card?.payload);
  assert('the card payload parses', cardPayload !== null);
  if (cardPayload) {
    assertEqual('the card carries the confirmed name', cardPayload.name, 'Overnight Muesli Jar');
    assertEqual('the card carries the draft id', cardPayload.id, 'label_test_1');
    assertEqual('the card carries the serving size', cardPayload.servingSize, '2/3 cup (55g)');
    assertEqual('the card carries the calories', cardPayload.calories, 230);
    assertEqual('the card carries the suggested slot', cardPayload.suggestedSlot, 'lunch');
    assertEqual('the card carries the fiber extra', cardPayload.fiber ?? -1, 4);
    assert('an unflagged read carries no flag', cardPayload.flagged === undefined);
    assert('a fresh card is not added yet', cardPayload.added === undefined);
  }

  // 5g. Rename from the card: beginLabelRename hands the NEXT typed message
  // to the card, updating its payload in place.
  await actSettle(() => {
    chat.beginLabelRename(cardMessage.id);
  });
  assertEqual('beginLabelRename opens the renaming flow', chat.labelFlow?.phase ?? '', 'renaming');
  assertEqual('the renaming flow targets the card message', chat.labelFlow?.cardMessageId ?? '', cardMessage.id);
  await actSettle(() => {
    chat.send('overnight muesli original jar');
  });
  assertEqual('the rename opens NO coach stream', opened.length, 0);
  {
    const renamed = chat.messages.find(m => m.id === cardMessage.id);
    const renamedPayload = parseLabelFoodCardPayload(renamed?.card?.payload);
    assertEqual(
      'the card payload takes the Title Case rename in place',
      renamedPayload?.name ?? '',
      'Overnight Muesli Original Jar',
    );
    assertEqual(
      'the rename is acknowledged in the coach voice',
      tailMessage().text,
      labelRenamedAck('Overnight Muesli Original Jar'),
    );
    assert('the rename closes the flow', chat.labelFlow === null);
  }

  // 5h. With the flow closed, text reaches the coach again. The name
  // conversation happened client-side, but its bubbles are ordinary done
  // messages, so the request history carries them: the coach's later turns
  // know the food and its confirmed name without any model-side state.
  await actSettle(() => {
    chat.send('Thanks coach.');
  });
  const sL2 = takeStream('post-flow follow-up');
  {
    const msgs = sL2.requestBody.messages ?? [];
    assertEqual(
      'the post-flow send reaches the coach',
      msgs[msgs.length - 1]?.content ?? '',
      'Thanks coach.',
    );
    assert(
      'the client-side rename ack rides the request history',
      msgs.some(
        m => m.role === 'assistant' && m.content === labelRenamedAck('Overnight Muesli Original Jar'),
      ),
    );
    assert(
      "the patient's typed rename rides the request history",
      msgs.some(m => m.role === 'user' && m.content === 'overnight muesli original jar'),
    );
    assert(
      'no message in the follow-up carries an image or photoKind',
      msgs.every(m => m.image === undefined && m.photoKind === undefined),
    );
  }
  await actSettle(() => {
    sL2.emit({ content: 'Anytime. That jar sounds like a solid breakfast.' });
    sL2.emit({ done: true });
    sL2.close();
  });
  await waitUntil('the post-flow reply finalizes', () => tailMessage().status === 'done');

  // ── 6. Kindless label routing, retry pinning, abandon, error, stop ────────

  // 6a. A kindless photo the server announces as "label" stamps the turn;
  // retry() names the label route explicitly and the retried reply opens
  // the flow (flagged draft with a blank container parses through).
  await actSettle(() => {
    chat.sendPhoto(LABEL_KINDLESS_PHOTO);
  });
  const kindlessLabelTurnId = chat.messages[chat.messages.length - 2].id;
  const sL3 = takeStream('kindless label turn');
  {
    const msgs = sL3.requestBody.messages ?? [];
    assert(
      'the kindless label send carries NO photoKind',
      msgs[msgs.length - 1]?.photoKind === undefined,
    );
  }
  await actSettle(() => {
    sL3.emit({ photoKind: 'label' });
    sL3.emit({ error: 'The coach hit a snag reading that photo.' });
    sL3.close();
  });
  await waitUntil('the kindless label turn errors', () => tailMessage().status === 'error');
  assertEqual(
    "the route announcement stamped 'label' onto the photo turn",
    chat.messages.find(m => m.id === kindlessLabelTurnId)?.photo?.kind ?? '',
    'label',
  );
  assert('an errored label turn holds no draft', chat.labelFlow === null);
  assert(
    'a stamped label turn offers no meal retake chip',
    offersMealPhotoRetake(chat.messages, chat.isStreaming) === false,
  );
  const labelErrorId = tailMessage().id;
  await actSettle(() => {
    chat.retry(labelErrorId);
  });
  const sL4 = takeStream('label retry');
  {
    const msgs = sL4.requestBody.messages ?? [];
    const tail = msgs[msgs.length - 1];
    assertEqual('the retry names the announced label route', tail?.photoKind ?? '', 'label');
    assertEqual('the retry re-sends the same label photo', tail?.image ?? '', LABEL_KINDLESS_PHOTO.uri);
    assertEqual('the retry keeps the generic replay text', tail?.content ?? '', PHOTO_MESSAGE_TEXT);
  }
  await actSettle(() => {
    sL4.emit({ content: 'Got it this time. Now, what is this one called?' });
    sL4.emit({
      labelDraft: {
        id: 'label_test_2',
        servingSize: '1 bar (40g)',
        servingsPerContainer: null,
        calories: 190,
        protein: 9,
        carbs: 18,
        fat: 9,
        suggestedSlot: 'snacks',
        flagged: true,
      },
    });
    sL4.emit({ done: true });
    sL4.close();
  });
  await waitUntil(
    'the retried label reply opens the flow',
    () => chat.labelFlow?.phase === 'awaiting-name',
  );
  assert('a flagged draft parses through', chat.labelFlow?.draft.flagged === true);
  assert(
    'a blank servings-per-container parses through',
    chat.labelFlow?.draft.servingsPerContainer === null,
  );

  // 6b. A new photo abandons the pending name conversation.
  await actSettle(() => {
    chat.sendPhoto(MENU_PHOTO);
  });
  assert('a fresh photo abandons the pending label flow', chat.labelFlow === null);
  const sL5 = takeStream('abandoning photo turn');
  await actSettle(() => {
    sL5.emit({ photoKind: 'menu' });
    sL5.emit({ content: 'Menu noted.' });
    sL5.emit({ done: true });
    sL5.close();
  });
  await waitUntil('the abandoning turn finalizes', () => tailMessage().status === 'done');

  // 6c. Stop mid-reveal: the held draft survives exactly when the partial
  // bubble was kept, so the name ask refers to text the patient saw.
  await actSettle(() => {
    chat.sendPhoto(LABEL_PHOTO, 'label');
  });
  const sL6 = takeStream('stopped label turn');
  await actSettle(() => {
    sL6.emit({ content: LABEL_REPLY_TEXT });
    sL6.emit({ labelDraft: LABEL_DRAFT });
  });
  await waitUntil('the stopped turn revealed some text', () => tailMessage().text.length > 0);
  await actSettle(() => {
    chat.stop();
  });
  {
    const stoppedTail = tailMessage();
    assert('stop finalizes the partial bubble', stoppedTail.status === 'done' && stoppedTail.stopped === true);
  }
  assertEqual(
    'stop with a kept bubble still opens the name conversation',
    chat.labelFlow?.phase ?? '',
    'awaiting-name',
  );

  // ── 7. Add-from-card integration: the same paths as Add Food ──────────────
  {
    const payload = parseLabelFoodCardPayload(
      chat.messages.find(m => m.id === cardMessage.id)?.card?.payload,
    );
    if (!payload) {
      fail('the food card payload should still parse for the add step');
      finish();
    }

    const foodsBefore = patient.customFoods.length;
    const entriesBefore = patient.entriesForDate(TODAY_KEY).length;

    let food!: Awaited<ReturnType<typeof patient.addCustomFood>>;
    await act(async () => {
      food = await patient.addCustomFood(buildCustomFoodFromLabel(payload));
    });
    assertEqual('the saved food keeps the confirmed name', food.name, 'Overnight Muesli Original Jar');
    assertEqual('the saved food serves the label serving', food.serving, '2/3 cup (55g)');
    assertEqual('the saved food keeps the label calories', food.calories, 230);
    assertEqual('the saved food keeps the label protein', food.protein, 8);
    assertEqual('the saved food lands in "My Foods"', food.category, 'My Foods');
    assertEqual('the food list grew by one', patient.customFoods.length, foodsBefore + 1);
    assert(
      'the saved food is visible in the Add Food data source',
      patient.customFoods.some(f => f.id === food.id),
    );

    await act(async () => {
      await patient.addEntry(buildLabelDiaryEntry(food, 'lunch', TODAY_KEY));
    });
    const entries = patient.entriesForDate(TODAY_KEY);
    assertEqual('the diary gained exactly one entry', entries.length, entriesBefore + 1);
    const entry = entries.find(e => e.refId === food.id);
    assert('the logged entry references the saved food', entry !== undefined);
    assertEqual('the entry lands in the chosen slot', entry?.meal ?? '', 'lunch');
    assertEqual('the entry logs one serving', entry?.detail ?? '', '1 × 2/3 cup (55g)');
    assertEqual('the entry carries the label calories', entry?.calories ?? -1, 230);
    assertEqual('the entry kind is "food"', entry?.kind ?? '', 'food');

    // The card freezes once added: payload flips, and beginLabelRename
    // refuses (renames now belong to the custom-food edit screen).
    await actSettle(() => {
      chat.markLabelFoodAdded(cardMessage.id, 'lunch');
    });
    const frozen = parseLabelFoodCardPayload(
      chat.messages.find(m => m.id === cardMessage.id)?.card?.payload,
    );
    assert('markLabelFoodAdded flips the payload', frozen?.added === true);
    assertEqual('the frozen payload remembers the slot', frozen?.addedSlot ?? '', 'lunch');
    await actSettle(() => {
      chat.beginLabelRename(cardMessage.id);
    });
    assert(
      'beginLabelRename refuses an added card',
      chat.labelFlow === null || chat.labelFlow.phase === 'awaiting-name',
    );

    // Saved from chat means editable like any custom food.
    await act(async () => {
      await patient.updateCustomFood(food.id, {
        name: 'Muesli Jar',
        serving: food.serving,
        calories: food.calories,
        protein: food.protein,
        carbs: food.carbs,
        fat: food.fat,
      });
    });
    assertEqual(
      'the saved food edits like any custom food',
      patient.customFoods.find(f => f.id === food.id)?.name ?? '',
      'Muesli Jar',
    );
  }

  assertEqual('every label-flow stream was accounted for', opened.length, 0);
  labelTree.unmount();

  // ── 8. Title Case: the one shared naming helper ────────────────────────────
  assertEqual('title-cases a plain lowercase name', toTitleCase('overnight muesli'), 'Overnight Muesli');
  assertEqual(
    'keeps small words down mid-name',
    toTitleCase('grilled chicken with sweet potatoes'),
    'Grilled Chicken with Sweet Potatoes',
  );
  assertEqual('capitalizes the first word even when small', toTitleCase('on the go trail mix'), 'On the Go Trail Mix');
  assertEqual('capitalizes the last word even when small', toTitleCase('food to go'), 'Food to Go');
  assertEqual('leaves deliberate caps alone', toTitleCase('PB&J bar'), 'PB&J Bar');
  assertEqual("keeps brand inner caps (McCann's)", toTitleCase("McCann's steel cut oats"), "McCann's Steel Cut Oats");
  assertEqual('capitalizes hyphen segments', toTitleCase('7-grain crackers'), '7-Grain Crackers');
  assertEqual('collapses stray whitespace', toTitleCase('  greek   yogurt '), 'Greek Yogurt');
  assertEqual('is idempotent', toTitleCase(toTitleCase('overnight muesli original')), 'Overnight Muesli Original');

  finish();
}

main().catch(error => {
  console.error('meal photo check crashed:', error);
  process.exit(1);
});
