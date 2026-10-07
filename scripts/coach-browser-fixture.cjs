#!/usr/bin/env node
'use strict';

/**
 * Disposable, in-browser Coach navigation fixture.
 *
 * This is intentionally not a live-account helper. It creates no Supabase
 * rows, never calls Supabase Auth, and has no secret input. Playwright routes
 * the mobile app's own /api requests to the synthetic wire fixtures below.
 *
 * Playwright usage:
 *
 *   const { createCoachBrowserFixture } = require('./scripts/coach-browser-fixture.cjs');
 *   const fixture = createCoachBrowserFixture({
 *     expoOrigin: 'https://<REPLIT_EXPO_DEV_DOMAIN>',
 *     apiOrigin: 'https://<REPLIT_DEV_DOMAIN>',
 *     holdList: true,
 *     holdThread: true,
 *   });
 *   await fixture.install(context); // or fixture.install(page)
 *   const page = await context.newPage();
 *   await page.goto(`${fixture.expoOrigin}/progress`);
 *   await fixture.release('list');
 *
 * The factory also accepts a Playwright page/context as its first argument:
 *   const fixture = createCoachBrowserFixture(page, { holdList: true });
 *   await fixture.ready;
 *
 * `holdList`, `holdThread`, and `holdStream` are opt-in so an ordinary tester
 * pass does not deadlock. During a held request use release(name), and inspect
 * requestCounts()/requests() without exposing request headers or tokens.
 */

const DEFAULT_PATIENT_ID = '00000000-0000-4524-8524-000000000524';
const DEFAULT_USER_ID = '00000000-0000-4524-8524-000000000525';
const DEFAULT_CONVERSATION_ID = 'synthetic-coach-001';
const DEFAULT_FAILED_CONVERSATION_ID = 'synthetic-coach-failed';
const API_ROUTE_PATTERN = '**/api/**';
const GATE_NAMES = ['list', 'thread', 'stream'];

function normalizeOrigin(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty origin`);
  }
  const raw = value.trim();
  const origin = `${/^[a-z][a-z\d+\-.]*:\/\//i.test(raw) ? '' : 'https://'}${raw}`.replace(/\/+$/, '');
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`${label} must use http or https`);
  }
  return origin;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function b64url(value) {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function syntheticAccessToken(userId = DEFAULT_USER_ID) {
  // A JWT-shaped token is enough for the real Supabase client to preserve and
  // return this session. The browser fixture never sends it to a real server.
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      aud: 'authenticated',
      sub: userId,
      email: 'coach-browser-patient@synthetic.invalid',
      role: 'authenticated',
      iat: 1700000000,
      exp: 4102444800,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { first_name: 'Synthetic', last_name: 'Patient' },
    }),
  );
  return `${header}.${payload}.synthetic-task-524`;
}

function syntheticSession(userId = DEFAULT_USER_ID) {
  const user = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'coach-browser-patient@synthetic.invalid',
    phone: '',
    confirmation_sent_at: null,
    confirmed_at: '2026-01-01T00:00:00.000Z',
    email_confirmed_at: '2026-01-01T00:00:00.000Z',
    phone_confirmed_at: null,
    last_sign_in_at: '2026-01-01T00:00:00.000Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { first_name: 'Synthetic', last_name: 'Patient' },
    identities: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return {
    access_token: syntheticAccessToken(userId),
    refresh_token: 'synthetic-refresh-token-task-524',
    token_type: 'bearer',
    expires_in: 604800,
    expires_at: 4102444800,
    user,
  };
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(milliseconds) {
  return milliseconds > 0
    ? new Promise(resolve => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

function makeConversation({
  id,
  title,
  titleState = 'ready',
  processingState = 'ready',
  updatedAt = '2026-01-15T12:00:00.000Z',
}) {
  return {
    id,
    title,
    titleState,
    archivedAt: null,
    createdAt: '2026-01-14T12:00:00.000Z',
    updatedAt,
    version: 1,
    processingState,
  };
}

const DEFAULT_CONVERSATION = makeConversation({
  id: DEFAULT_CONVERSATION_ID,
  title: 'Synthetic meal planning',
});

const DEFAULT_FAILED_CONVERSATION = makeConversation({
  id: DEFAULT_FAILED_CONVERSATION_ID,
  title: 'Synthetic follow-up',
  titleState: 'failed',
  processingState: 'failed',
  updatedAt: '2026-01-13T12:00:00.000Z',
});

const DEFAULT_MESSAGES = [
  {
    id: 'synthetic-coach-message-001',
    role: 'assistant',
    text: 'Hi Synthetic, I am your THINNR Coach. What would you like to work on today?',
    seq: 1,
    createdAt: '2026-01-14T12:01:00.000Z',
  },
  {
    id: 'synthetic-coach-message-002',
    role: 'user',
    text: 'Help me plan a balanced dinner.',
    seq: 2,
    createdAt: '2026-01-14T12:02:00.000Z',
  },
  {
    id: 'synthetic-coach-message-003',
    role: 'assistant',
    text: 'A simple plate with lean protein, vegetables, and a measured carbohydrate would be a good fit.',
    seq: 3,
    createdAt: '2026-01-14T12:03:00.000Z',
    replyToId: 'synthetic-coach-message-002',
  },
];

const DEFAULT_STATE = {
  entries: [],
  water: {},
  targets: {
    calories: 1600,
    protein: 110,
    carbs: 145,
    fat: 55,
    waterOz: 72,
  },
  favorites: [],
  recents: [],
  customFoods: [],
  catalogFoods: [],
  savedRecipes: [],
  photos: [],
  checkIns: [],
  medications: [],
  doseLogs: [],
  flags: {
    nudgeOptOut: false,
    nudgeEngaged: false,
    nudgeLastSentKey: null,
    nudgeLastCrossingKey: null,
    onboardingComplete: true,
    onboardingAnswers: { goal: 'wellness', dietaryPattern: 'balanced' },
    notificationPrefs: { push: false, email: false, sms: false },
  },
  entry: {
    firstName: 'Synthetic',
    programStartDate: '2026-01-01',
    todayKey: '2026-01-15',
    programDay: 15,
  },
  profile: {
    firstName: 'Synthetic',
    lastName: 'Patient',
    email: 'coach-browser-patient@synthetic.invalid',
    phone: null,
    dateOfBirth: '1988-01-01',
    heightInches: 66,
    startingWeight: 205,
    currentWeight: 201,
    goalWeight: 175,
    timezone: 'America/Chicago',
    programId: 'thinnr',
    programStartDate: '2026-01-01',
    setupComplete: true,
  },
  privacy: {
    consent: {
      requiredVersion: '2026-09-01',
      recordedVersion: '2026-09-01',
      satisfied: true,
      photoAnalysis: false,
      recordedAt: '2026-01-01T00:00:00.000Z',
    },
    export: null,
    deletion: null,
  },
};

function defaultFixtures() {
  return {
    state: jsonClone(DEFAULT_STATE),
    conversations: [jsonClone(DEFAULT_CONVERSATION), jsonClone(DEFAULT_FAILED_CONVERSATION)],
    threads: {
      [DEFAULT_CONVERSATION_ID]: {
        conversation: jsonClone(DEFAULT_CONVERSATION),
        messages: jsonClone(DEFAULT_MESSAGES),
        nextBefore: null,
      },
      [DEFAULT_FAILED_CONVERSATION_ID]: {
        conversation: jsonClone(DEFAULT_FAILED_CONVERSATION),
        messages: [
          {
            id: 'synthetic-failed-message-001',
            role: 'assistant',
            text: 'This synthetic conversation is available for retry-processing checks.',
            seq: 1,
            createdAt: '2026-01-13T12:01:00.000Z',
          },
        ],
        nextBefore: null,
      },
    },
  };
}

function mergeFixtures(overrides) {
  const fixtures = defaultFixtures();
  if (!overrides || typeof overrides !== 'object') return fixtures;
  if (overrides.state && typeof overrides.state === 'object') {
    fixtures.state = { ...fixtures.state, ...jsonClone(overrides.state) };
  }
  if (Array.isArray(overrides.conversations)) {
    fixtures.conversations = jsonClone(overrides.conversations);
  }
  if (overrides.threads && typeof overrides.threads === 'object') {
    fixtures.threads = {
      ...fixtures.threads,
      ...jsonClone(overrides.threads),
    };
  }
  return fixtures;
}

function initStorageSource(payload) {
  const serialized = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `(() => {
  const fixture = ${serialized};
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('Coach fixture requires browser localStorage.');
  // SupabaseClient derives this exact key: sb-<project-ref>-auth-token.
  storage.setItem(fixture.storageKey, JSON.stringify(fixture.session));
  // Patient routes are admitted by AppModeContext only when patient mode is
  // persisted; the real whoami response still decides real-account admission.
  storage.setItem('thinnr_app_mode_v1', fixture.appMode);
})();`;
}

function isPlaywrightTarget(value) {
  return Boolean(value && typeof value.route === 'function' && typeof value.addInitScript === 'function');
}

function requestBody(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function routeOperation(url, method) {
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  if (method === 'GET' && path === '/claim/whoami') return 'whoami';
  if (segments[0] === 'patient-data') {
    if (segments[1] === 'state') return 'state';
    if (segments[1] === 'profile' && method === 'GET') return 'profile';
    if (segments[1] === 'profile' && method === 'PUT') return 'profileWrite';
    if (segments[1] === 'profile' && segments[2] === 'setup' && method === 'POST') return 'setup';
    if (segments[1] === 'setup' && method === 'PUT') return 'setup';
    if (segments[1] === 'privacy') return 'privacy';
    if (segments[1] === 'consent') return 'consent';
    if (segments[1] === 'flags') return 'flags';
    if (segments[1] === 'health-measurements') return 'healthMeasurements';
    return 'patientDataWrite';
  }
  if (segments[0] === 'patient-coach' && segments[1] === 'conversations') {
    if (segments.length === 2 && method === 'GET') return 'list';
    if (segments.length === 2 && method === 'POST') return 'create';
    if (segments.length === 3 && segments[3] === undefined && method === 'GET') return 'thread';
    if (segments.length === 4 && segments[3] === 'messages' && method === 'POST') return 'append';
    if (segments.length === 4 && segments[3] === 'retry-processing' && method === 'POST') return 'retryProcessing';
    if (segments.length === 3 && method === 'PATCH') return 'archive';
  }
  if (segments[0] === 'patient-coach' && segments[1] === 'memories' && method === 'GET') {
    return 'memories';
  }
  if (segments[0] === 'patient-chat') return 'legacyChat';
  if (segments[0] === 'coach' && segments[1] === 'availability' && method === 'GET') {
    return 'coachAvailability';
  }
  if (segments[0] === 'coach' && segments[1] === 'chat' && method === 'POST') return 'stream';
  return 'unsupported';
}

function threadIdFromPath(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const index = segments.indexOf('conversations');
  return index >= 0 ? decodeURIComponent(segments[index + 1] || '') : '';
}

function createCoachBrowserFixture(targetOrOptions, maybeOptions) {
  const target = isPlaywrightTarget(targetOrOptions) ? targetOrOptions : null;
  const options = (target ? maybeOptions : targetOrOptions) || {};
  const expoOrigin = normalizeOrigin(
    options.expoOrigin ||
      process.env.REPLIT_EXPO_DEV_DOMAIN ||
      (() => {
        throw new Error('Coach fixture requires expoOrigin or REPLIT_EXPO_DEV_DOMAIN.');
      })(),
    'expoOrigin',
  );
  const apiOrigin = normalizeOrigin(
    options.apiOrigin ||
      process.env.REPLIT_DEV_DOMAIN ||
      (() => {
        throw new Error('Coach fixture requires apiOrigin or REPLIT_DEV_DOMAIN.');
      })(),
    'apiOrigin',
  );
  // No built-in default: the URL must come from the environment so the fixture
  // always follows the workspace's (development) Supabase project.
  const supabaseUrl = options.supabaseUrl || process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('EXPO_PUBLIC_SUPABASE_URL is not set');
  const storageKey =
    options.storageKey || `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const patientId = options.patientId || DEFAULT_PATIENT_ID;
  const userId = options.userId || DEFAULT_USER_ID;
  const appMode = 'patient';
  const session = options.session ? jsonClone(options.session) : syntheticSession(userId);
  const fixtures = mergeFixtures(options.fixtures);
  const coldDelayMs =
    options.coldDelayMs === undefined ? 250 : Math.max(0, Number(options.coldDelayMs) || 0);
  const streamOptions = {
    text: 'Synthetic Coach reply for task 524. Your next small step can be simple.',
    chunks: null,
    hold: Boolean(options.holdStream),
  };
  if (options.stream && typeof options.stream === 'object') {
    if (typeof options.stream.text === 'string') streamOptions.text = options.stream.text;
    if (Array.isArray(options.stream.chunks)) streamOptions.chunks = options.stream.chunks.slice();
    if (options.stream.hold !== undefined) streamOptions.hold = Boolean(options.stream.hold);
  }

  const gateState = Object.fromEntries(
    GATE_NAMES.map(name => [
      name,
      {
        held: Boolean(options[`hold${name[0].toUpperCase()}${name.slice(1)}`]),
        deferred: null,
      },
    ]),
  );
  for (const name of GATE_NAMES) {
    if (gateState[name].held) gateState[name].deferred = defer();
  }
  if (streamOptions.hold && !gateState.stream.held) {
    gateState.stream.held = true;
    gateState.stream.deferred = defer();
  }

  const counts = {
    whoami: 0,
    state: 0,
    profile: 0,
    profileWrite: 0,
    setup: 0,
    privacy: 0,
    consent: 0,
    flags: 0,
    coachAvailability: 0,
    list: 0,
    thread: 0,
    create: 0,
    append: 0,
    stream: 0,
    retryProcessing: 0,
    archive: 0,
    memories: 0,
    legacyChat: 0,
    patientDataWrite: 0,
    healthMeasurements: 0,
    unsupported: 0,
  };
  const requests = [];
  const listeners = new Set();
  const waiters = [];
  const seenColdKeys = new Set();
  const failureQueues = new Map();
  let unauthorized = Boolean(options.unauthorized);
  let installedTarget = null;
  let routeHandler = null;

  function notifyRequest(operation) {
    for (const waiter of waiters.slice()) {
      if (waiter.operation === operation && counts[operation] >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(counts[operation]);
      }
    }
    for (const listener of listeners) listener(requests[requests.length - 1]);
  }

  function recordRequest(request, url, operation) {
    if (counts[operation] !== undefined) counts[operation] += 1;
    const record = {
      operation,
      method: request.method(),
      path: url.pathname,
      query: url.search,
      number: counts[operation] ?? 0,
    };
    requests.push(record);
    notifyRequest(operation);
  }

  function hold(name) {
    if (!GATE_NAMES.includes(name)) throw new Error(`Unknown Coach fixture gate: ${name}`);
    const gate = gateState[name];
    gate.held = true;
    if (!gate.deferred) gate.deferred = defer();
    return fixture;
  }

  function release(name) {
    if (!GATE_NAMES.includes(name)) throw new Error(`Unknown Coach fixture gate: ${name}`);
    const gate = gateState[name];
    gate.held = false;
    if (gate.deferred) {
      gate.deferred.resolve();
      gate.deferred = null;
    }
    return fixture;
  }

  function releaseAll() {
    for (const name of GATE_NAMES) release(name);
    return fixture;
  }

  function failNext(operation, response = {}) {
    if (!Object.prototype.hasOwnProperty.call(counts, operation)) {
      throw new Error(`Unknown Coach fixture operation: ${operation}`);
    }
    const queue = failureQueues.get(operation) || [];
    queue.push({
      status: Number(response.status) || 503,
      body: {
        error:
          typeof response.error === 'string'
            ? response.error
            : 'Synthetic transient fixture failure.',
        ...(response.code ? { code: response.code } : {}),
        ...(response.retryable === false ? { retryable: false } : {}),
      },
    });
    failureQueues.set(operation, queue);
    return fixture;
  }

  function takeFailure(operation) {
    const queue = failureQueues.get(operation);
    if (!queue || queue.length === 0) return null;
    const failure = queue.shift();
    if (queue.length === 0) failureQueues.delete(operation);
    return failure;
  }

  function updateConversation(conversation) {
    const index = fixtures.conversations.findIndex(item => item.id === conversation.id);
    if (index >= 0) fixtures.conversations[index] = conversation;
    else fixtures.conversations.unshift(conversation);
    const thread = fixtures.threads[conversation.id];
    if (thread) thread.conversation = conversation;
  }

  function makeSseBody(request) {
    const body = requestBody(request);
    const chunks =
      streamOptions.chunks && streamOptions.chunks.length > 0
        ? streamOptions.chunks
        : [streamOptions.text];
    const events = [];
    if (body && body.messages && body.messages.length > 0) {
      events.push({ stage: 'received' });
    }
    for (const chunk of chunks) {
      if (typeof chunk === 'string' && chunk.length > 0) events.push({ content: chunk });
    }
    events.push({ done: true });
    return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  }

  function corsHeaders(request) {
    const origin = request.headers().origin;
    return {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-thinnr-device, x-thinnr-platform',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  async function fulfillJson(route, request, status, value) {
    try {
      await route.fulfill({
        status,
        headers: {
          ...corsHeaders(request),
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
        body: JSON.stringify(value),
      });
    } catch {
      // A stopped synthetic SSE/fetch can close its route before release.
    }
  }

  async function routeRequest(route) {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    if (method === 'OPTIONS') {
      try {
        await route.fulfill({ status: 204, headers: corsHeaders(request) });
      } catch {
        // The browser may close an unused preflight while navigation changes.
      }
      return;
    }

    const operation = routeOperation(url, method);
    if (counts[operation] === undefined) counts[operation] = 0;
    recordRequest(request, url, operation);

    if (unauthorized) {
      await fulfillJson(route, request, 401, {
        error: 'Synthetic fixture unauthorized.',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    const coldKey = `${method} ${url.pathname}${url.search}`;
    if (!seenColdKeys.has(coldKey)) {
      seenColdKeys.add(coldKey);
      await sleep(coldDelayMs);
    }

    const failure = takeFailure(operation);
    if (failure) {
      await fulfillJson(route, request, failure.status, failure.body);
      return;
    }

    if (operation === 'list' && gateState.list.held) await gateState.list.deferred.promise;
    if (operation === 'thread' && gateState.thread.held) await gateState.thread.deferred.promise;
    if (operation === 'stream' && gateState.stream.held) {
      if (!gateState.stream.deferred) gateState.stream.deferred = defer();
      await gateState.stream.deferred.promise;
    }

    const query = url.searchParams;
    if (operation === 'whoami') {
      await fulfillJson(route, request, 200, { kind: 'patient', patientId });
      return;
    }
    if (operation === 'state') {
      await fulfillJson(route, request, 200, fixtures.state);
      return;
    }
    if (operation === 'profile') {
      await fulfillJson(route, request, 200, { profile: fixtures.state.profile });
      return;
    }
    if (operation === 'profileWrite' || operation === 'setup') {
      const body = requestBody(request);
      if (body && body.profile && typeof body.profile === 'object') {
        fixtures.state.profile = { ...fixtures.state.profile, ...body.profile };
      }
      await fulfillJson(route, request, 200, { profile: fixtures.state.profile });
      return;
    }
    if (operation === 'privacy') {
      await fulfillJson(route, request, 200, fixtures.state.privacy);
      return;
    }
    if (operation === 'consent') {
      const body = requestBody(request);
      if (method === 'PUT' && body && typeof body.policyVersion === 'string') {
        const consent = fixtures.state.privacy.consent;
        fixtures.state.privacy.consent = {
          ...consent,
          recordedVersion: body.policyVersion,
          requiredVersion: body.policyVersion,
          satisfied: true,
          photoAnalysis: typeof body.photoAnalysis === 'boolean' ? body.photoAnalysis : consent.photoAnalysis,
          recordedAt: '2026-01-15T12:00:00.000Z',
        };
      }
      await fulfillJson(route, request, 200, { consent: fixtures.state.privacy.consent });
      return;
    }
    if (operation === 'flags') {
      const body = requestBody(request);
      if (body && typeof body === 'object') fixtures.state.flags = { ...fixtures.state.flags, ...body };
      await fulfillJson(route, request, 200, { ok: true });
      return;
    }
    if (operation === 'list') {
      const archived = query.get('archived') === 'true';
      const offset = Math.max(0, Number(query.get('offset') || 0) || 0);
      const visible = fixtures.conversations.filter(row => Boolean(row.archivedAt) === archived);
      const page = visible.slice(offset, offset + 20);
      await fulfillJson(route, request, 200, {
        conversations: page,
        total: visible.length,
        nextOffset: offset + page.length < visible.length ? offset + page.length : null,
      });
      return;
    }
    if (operation === 'thread') {
      const id = threadIdFromPath(url);
      const thread = fixtures.threads[id];
      if (!thread) {
        await fulfillJson(route, request, 404, { error: 'Synthetic conversation not found.', code: 'NOT_FOUND' });
        return;
      }
      await fulfillJson(route, request, 200, {
        conversation: thread.conversation,
        messages: thread.messages,
        nextBefore: query.has('before') ? null : thread.nextBefore,
        patient: { firstName: 'Synthetic', programDay: 15 },
      });
      return;
    }
    if (operation === 'create') {
      const now = '2026-01-15T12:30:00.000Z';
      const conversation = makeConversation({
        id: `synthetic-created-${counts.create}`,
        title: 'New conversation',
        updatedAt: now,
      });
      updateConversation(conversation);
      fixtures.threads[conversation.id] = {
        conversation,
        messages: [],
        nextBefore: null,
      };
      await fulfillJson(route, request, 200, { conversation });
      return;
    }
    if (operation === 'append') {
      const id = threadIdFromPath(url);
      const thread = fixtures.threads[id];
      const body = requestBody(request);
      if (thread && Array.isArray(body?.messages)) {
        const existing = new Set(thread.messages.map(message => message.id));
        thread.messages.push(...body.messages.filter(message => !existing.has(message.id)));
        thread.conversation = {
          ...thread.conversation,
          updatedAt: '2026-01-15T12:31:00.000Z',
        };
        updateConversation(thread.conversation);
      }
      await fulfillJson(route, request, 200, { ok: true });
      return;
    }
    if (operation === 'retryProcessing') {
      const id = threadIdFromPath(url);
      const thread = fixtures.threads[id];
      if (thread) {
        thread.conversation = {
          ...thread.conversation,
          title: thread.conversation.title === 'Synthetic follow-up' ? 'Recovered synthetic chat' : thread.conversation.title,
          titleState: 'ready',
          processingState: 'ready',
          version: thread.conversation.version + 1,
        };
        updateConversation(thread.conversation);
      }
      await fulfillJson(route, request, 200, { ok: true });
      return;
    }
    if (operation === 'archive') {
      const id = threadIdFromPath(url);
      const body = requestBody(request);
      const thread = fixtures.threads[id];
      if (!thread) {
        await fulfillJson(route, request, 404, { error: 'Synthetic conversation not found.', code: 'NOT_FOUND' });
        return;
      }
      const archived = body?.archived === true;
      thread.conversation = {
        ...thread.conversation,
        archivedAt: archived ? '2026-01-15T12:32:00.000Z' : null,
        version: thread.conversation.version + 1,
      };
      updateConversation(thread.conversation);
      await fulfillJson(route, request, 200, { conversation: thread.conversation });
      return;
    }
    if (operation === 'memories') {
      await fulfillJson(route, request, 200, { memories: [], total: 0, nextOffset: null });
      return;
    }
    if (operation === 'coachAvailability') {
      await fulfillJson(route, request, 200, { available: true, message: null });
      return;
    }
    if (operation === 'stream') {
      try {
        await route.fulfill({
          status: 200,
          headers: {
            ...corsHeaders(request),
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-store',
            connection: 'keep-alive',
          },
          body: makeSseBody(request),
        });
      } catch {
        // Abort is the expected result when the tester presses Stop.
      }
      return;
    }
    if (operation === 'healthMeasurements') {
      const body = requestBody(request);
      await fulfillJson(route, request, 200, {
        imported: Array.isArray(body?.measurements) ? body.measurements.length : 0,
      });
      return;
    }
    if (operation === 'legacyChat') {
      await fulfillJson(route, request, 200, {
        messages: [],
        patient: { firstName: 'Synthetic', programDay: 15 },
      });
      return;
    }
    if (operation === 'patientDataWrite') {
      await fulfillJson(route, request, 200, { ok: true });
      return;
    }

    // Never let an unrecognized app call accidentally reach a real API. A
    // visible 501 is safer than a silent production request or fake success.
    await fulfillJson(route, request, 501, {
      error: `Synthetic Coach fixture has no response for ${method} ${url.pathname}.`,
      code: 'FIXTURE_ROUTE_MISSING',
    });
  }

  const fixture = {
    expoOrigin,
    apiOrigin,
    patientId,
    userId,
    appMode,
    storageKey,
    session: jsonClone(session),
    fixtures,
    initScriptSource: initStorageSource({
      storageKey,
      session,
      appMode,
    }),
    hold,
    release,
    releaseAll,
    setUnauthorized(value = true) {
      unauthorized = Boolean(value);
      return fixture;
    },
    unauthorized() {
      return unauthorized;
    },
    failNext,
    clearFailures(operation) {
      if (operation === undefined) failureQueues.clear();
      else failureQueues.delete(operation);
      return fixture;
    },
    setStream(next = {}) {
      if (typeof next.text === 'string') streamOptions.text = next.text;
      if (Array.isArray(next.chunks)) streamOptions.chunks = next.chunks.slice();
      if (next.hold !== undefined) {
        streamOptions.hold = Boolean(next.hold);
        if (streamOptions.hold) hold('stream');
        else if (!gateState.stream.held) release('stream');
      }
      return fixture;
    },
    requestCounts() {
      return { ...counts };
    },
    requests() {
      return requests.map(record => ({ ...record }));
    },
    onRequest(listener) {
      if (typeof listener !== 'function') throw new TypeError('onRequest requires a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForRequest(operation, { count = 1, timeoutMs = 10_000 } = {}) {
      if (!Object.prototype.hasOwnProperty.call(counts, operation)) {
        return Promise.reject(new Error(`Unknown Coach fixture operation: ${operation}`));
      }
      if (counts[operation] >= count) return Promise.resolve(counts[operation]);
      return new Promise((resolve, reject) => {
        const waiter = {
          operation,
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for synthetic ${operation} request #${count}.`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async install(owner = target) {
      if (!isPlaywrightTarget(owner)) {
        throw new TypeError('fixture.install requires a Playwright page or browser context');
      }
      if (installedTarget && installedTarget !== owner) {
        throw new Error('Coach browser fixture is already installed on another target');
      }
      if (installedTarget === owner) return fixture;
      routeHandler = routeRequest;
      // Add storage before the Expo bundle executes, then intercept every API
      // call. No helper page, login, network account, or DB mutation is used.
      await owner.addInitScript({ content: fixture.initScriptSource });
      await owner.route(API_ROUTE_PATTERN, routeHandler);
      installedTarget = owner;
      return fixture;
    },
    async dispose() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Coach browser fixture disposed.'));
      }
      releaseAll();
      if (installedTarget && routeHandler && typeof installedTarget.unroute === 'function') {
        await installedTarget.unroute(API_ROUTE_PATTERN, routeHandler);
      }
      installedTarget = null;
      routeHandler = null;
      return fixture;
    },
  };

  // A factory passed a page/context is immediately useful while still
  // exposing a deterministic promise for test setup ordering.
  fixture.ready = target ? fixture.install(target) : Promise.resolve(fixture);
  return fixture;
}

module.exports = {
  createCoachBrowserFixture,
  initStorageSource,
  SYNTHETIC_ACCESS_TOKEN: syntheticAccessToken(),
};