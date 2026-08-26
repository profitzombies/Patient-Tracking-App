/**
 * AI Support chat — live end-to-end check of the provider-facing assistant.
 *
 * The hermetic vitest suites (api-server src/support, src/routes/support.test.ts)
 * pin the mechanics: routing stages, broadening, guards, limits, SSE framing.
 * This script checks what only REAL model calls over the REAL seeded library
 * can prove — that the assembled persona actually behaves:
 *
 *   1. An in-scope program question gets a comprehensive, markdown-formatted
 *      answer (headers/bullets/bold, strictly NO emojis) with the
 *      deterministic output guards holding on real traffic: no em/en
 *      dashes, never "Thinner", never an emoji.
 *   2. Stage narration rides the same stream in real work order — searching,
 *      then thinking, then formulating — and every stage event lands before
 *      the first visible content chunk (broadened turns may repeat the
 *      searching/thinking pair, never out of order).
 *   3. A question about a non-THINNR medication (metformin) ENDS with the
 *      exact primary-care-physician closer line the persona requires.
 *   4. A question the library cannot answer gets an honest "I don't know"
 *      that offers Support@Thinnrweightloss.com — not an invention.
 *   5. The open demo posture holds on the wire: the persona probes all run
 *      TOKENLESS (reaching the page is enough — the old 401 gate is
 *      retired), and a bearer-carrying call behaves identically, so
 *      signed-in staff clients keep working unchanged. Abuse is bounded by
 *      the chat's per-IP rate limits, not by auth.
 *
 * Live suite — needs the API server running (`artifacts/api-server`
 * workflow) with OpenAI credentials and the seeded knowledge library.
 * Model-judgment probes (2 and 3) get one retry to absorb sampling noise;
 * deterministic guard checks never need one.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:ai-support
 */

const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

const PCP_CLOSER =
  'If you have additional concerns, please have the patient check with their primary care physician.';
const SUPPORT_EMAIL = 'Support@Thinnrweightloss.com';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface StreamResult {
  status: number;
  text: string;
  sawDone: boolean;
  errorEvent: string | null;
  /** Stage narration events, in wire order. */
  stages: string[];
  /** The subset of `stages` that arrived before the first content chunk. */
  stagesBeforeContent: string[];
}

/**
 * Runs one chat turn and collects the streamed reply. Tokenless by default,
 * exactly like the open page; the bearer probe passes a synthetic token.
 */
async function ask(question: string, token: string | null = null): Promise<StreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${API_BASE}/api/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      return {
        status: response.status,
        text: await response.text().catch(() => ''),
        sawDone: false,
        errorEvent: null,
        stages: [],
        stagesBeforeContent: [],
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let sawDone = false;
    let errorEvent: string | null = null;
    const stages: string[] = [];
    const stagesBeforeContent: string[] = [];
    const drain = (chunk: string) => {
      buffer += chunk;
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as {
              content?: string;
              done?: boolean;
              error?: string;
              stage?: string;
            };
            if (typeof payload.stage === 'string') {
              stages.push(payload.stage);
              if (text.length === 0) stagesBeforeContent.push(payload.stage);
            }
            if (typeof payload.content === 'string') text += payload.content;
            if (payload.error) errorEvent = payload.error;
            if (payload.done) sawDone = true;
          } catch {
            // keepalive comments and partial lines are not data events
          }
        }
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      drain(decoder.decode(value, { stream: true }));
    }
    drain(`${decoder.decode()}\n\n`);
    return { status: response.status, text, sawDone, errorEvent, stages, stagesBeforeContent };
  } finally {
    clearTimeout(timer);
  }
}

/** Strips trailing whitespace/markdown so "ends with the closer" is testable. */
function trimDecorations(text: string): string {
  return text.replace(/[\s*_\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]+$/u, '');
}

/** Emoji detector for the no-emoji contract; ™/©/® are legitimate text. */
const EMOJI_PATTERN = /(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}/u;
const BANNED_REFERRAL = /consult (a|an|your|their) (healthcare|health care|medical) (provider|professional)/i;

/**
 * The only narration the server may stream: one searching/thinking pair per
 * grounding pass (a broadened turn repeats the pair), then exactly one
 * formulating right before the first visible content.
 */
function isCanonicalStageFlow(stages: string[]): boolean {
  return /^(?:searching,thinking,)*searching,thinking,formulating$/.test(stages.join(','));
}

async function probeInScope(): Promise<void> {
  console.log('probe: in-scope program question');
  const result = await ask('What foods are approved during the thinning phase?');
  check(
    'tokenless call responds 200 (the old 401 gate is retired)',
    result.status === 200,
    `status ${result.status}`,
  );
  check('stream finished with done', result.sawDone, result.errorEvent ?? 'no done event');
  check('no error event', result.errorEvent === null, result.errorEvent ?? '');
  const text = result.text;
  check('comprehensive length (>600 chars)', text.length > 600, `${text.length} chars`);
  check(
    'markdown structure (header or bullets)',
    /(^|\n)#{1,4} /.test(text) || /(^|\n)- /.test(text) || /(^|\n)\d+\. /.test(text),
  );
  check('uses bolding', text.includes('**'));
  check('never uses emojis', !EMOJI_PATTERN.test(text));
  check('no em/en dashes', !/[\u2014\u2013]/.test(text));
  check('never "Thinner"', !/\bTHINNER\b|\bThinner\b/.test(text));
  check('no broaden marker leak', !text.includes('[[broaden'));
  check('no banned referral phrasing', !BANNED_REFERRAL.test(text));
  check('grounded in the approved-foods material', /protein|vegetable|meal/i.test(text));
  const flow = result.stages.join(' > ') || '(none)';
  check('stage narration arrived', result.stages.length >= 3, flow);
  check('stages run searching > thinking > formulating', isCanonicalStageFlow(result.stages), flow);
  check(
    'every stage precedes the first content chunk',
    result.stages.length === result.stagesBeforeContent.length,
    flow,
  );
}

async function probePcpCloser(): Promise<void> {
  console.log('probe: non-THINNR medication question ends with the PCP closer');
  const question =
    'A patient is taking metformin for type 2 diabetes. Is that safe alongside the program?';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await ask(question);
    const ended = trimDecorations(result.text).endsWith(PCP_CLOSER);
    if (result.status === 200 && result.sawDone && ended) {
      if (attempt > 1) console.log('  (passed on retry)');
      check('reply ends with the exact PCP closer', true);
      check('no em/en dashes', !/[\u2014\u2013]/.test(result.text));
      check('never "Thinner"', !/\bTHINNER\b|\bThinner\b/.test(result.text));
      check('never uses emojis', !EMOJI_PATTERN.test(result.text));
      return;
    }
    if (attempt === 1) {
      console.log('  (first attempt missed the closer; retrying once for sampling noise)');
      continue;
    }
    check(
      'reply ends with the exact PCP closer',
      false,
      `status ${result.status}, done=${result.sawDone}, tail="${result.text.slice(-160)}"`,
    );
  }
}

async function probeHonestUnknown(): Promise<void> {
  console.log('probe: out-of-library question gets an honest answer');
  const question = 'Does THINNR offer a franchise program for opening new clinic locations?';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await ask(question);
    const text = result.text;
    const admitsUnknown =
      /(don'?t|do not) know|(don'?t|do not|doesn'?t|does not) (have|include|cover|contain|mention|address)|not (covered|included|found|mentioned|addressed|available) in/i.test(
        text,
      );
    const offersSupport = text.includes(SUPPORT_EMAIL);
    if (result.status === 200 && result.sawDone && admitsUnknown && offersSupport) {
      if (attempt > 1) console.log('  (passed on retry)');
      check('admits the library does not cover it', true);
      check('offers the support email', true);
      check('never uses emojis', !EMOJI_PATTERN.test(text));
      check(
        'stage narration stays canonical on the honest-unknown path',
        isCanonicalStageFlow(result.stages),
        result.stages.join(' > ') || '(none)',
      );
      return;
    }
    if (attempt === 1) {
      console.log('  (first attempt inconclusive; retrying once for sampling noise)');
      continue;
    }
    check('admits the library does not cover it', admitsUnknown, `text="${text.slice(0, 200)}"`);
    check('offers the support email', offersSupport, `tail="${text.slice(-200)}"`);
  }
}

/**
 * Signed-in staff clients still attach their session bearer; the open route
 * must treat that call exactly like a tokenless one — the header is simply
 * ignored, so a synthetic token proves the contract without any account.
 */
async function probeSignedInUnchanged(): Promise<void> {
  console.log('probe: bearer-carrying call (signed-in staff) behaves identically');
  const result = await ask('How should a patient take Boost, and when?', 'synthetic-staff-bearer');
  check('responds 200 with a bearer attached', result.status === 200, `status ${result.status}`);
  check('stream finished with done', result.sawDone, result.errorEvent ?? 'no done event');
  check('answer has substance', result.text.length > 100, `${result.text.length} chars`);
  check('never uses emojis', !EMOJI_PATTERN.test(result.text));
}

async function main(): Promise<void> {
  console.log(`AI Support live verification against ${API_BASE}\n`);
  await probeInScope();
  await probePcpCloser();
  await probeHonestUnknown();
  await probeSignedInUnchanged();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll AI Support live checks passed');
}

main().catch((error) => {
  console.error('verify-ai-support crashed:', error);
  process.exit(1);
});
