/**
 * StagePacer — hermetic timeline checks on a virtual clock.
 *
 * The pacer is the piece that makes the AI Support thinking narration
 * honest UNDER REAL STREAM TIMING: server stage events frequently arrive
 * back-to-back with the first content chunk (same network read), and
 * without pacing the last label would blink away — or never render. These
 * checks drive src/lib/stage-pacer.ts through injected virtual time and
 * assert EXACT label/flush/finalize timelines:
 *
 *   1. Back-to-back stages + content + done (the fast-turn race): every
 *      displayed label still holds its full minimum beat, text flushes only
 *      after the last beat, finalization rides with the flush.
 *   2. The last label's beat protects text even with an EMPTY queue —
 *      content arriving 50ms after "formulating" waits out the remainder.
 *   3. Broadened narration (searching/thinking repeat) paces in arrival
 *      order; consecutive duplicate stages dedup; post-gate stages are
 *      ignored once text is on screen.
 *   4. No-stage servers: the timed fallback walks the progression, a real
 *      server stage disarms it, and held text still waits out the beats.
 *   5. Interruptions never wait: finish() (Stop) flushes held text NOW and
 *      reports whether done had already arrived (so a completed reply is
 *      never marked "stopped"); cancel() (error/clear) goes silent.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:stage-pacer
 */
import {
  StagePacer,
  STAGE_MIN_VISIBLE_MS,
  FALLBACK_THINKING_AT_MS,
  FALLBACK_FORMULATING_AT_MS,
} from '../src/lib/stage-pacer';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Deterministic replacement for Date.now/setTimeout/clearTimeout. */
class VirtualClock {
  time = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = () => this.time;
  set = (fn: () => void, ms: number): unknown => {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.time + ms, fn });
    return this.seq;
  };
  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Runs due timers in (time, insertion) order up to `target`. */
  advanceTo(target: number): void {
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (timer.at < dueAt || (timer.at === dueAt && id < (dueId as number)))) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.time = dueAt;
      timer?.fn();
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

interface LogEntry {
  at: number;
  kind: 'stage' | 'text' | 'finalize';
  value?: string;
}

function makeHarness() {
  const clock = new VirtualClock();
  const log: LogEntry[] = [];
  const pacer = new StagePacer(
    {
      onStageChange: (stage) => log.push({ at: clock.time, kind: 'stage', value: stage }),
      onTextFlush: (text) => log.push({ at: clock.time, kind: 'text', value: text }),
      onFinalize: () => log.push({ at: clock.time, kind: 'finalize' }),
    },
    { now: clock.now, setTimer: clock.set, clearTimer: clock.clear },
  );
  return { clock, log, pacer };
}

function fmt(log: LogEntry[]): string {
  return log.map((entry) => `${entry.at}:${entry.kind}${entry.value ? `=${entry.value}` : ''}`).join(' | ');
}

function timelineEquals(log: LogEntry[], expected: Array<[number, string, string?]>): boolean {
  if (log.length !== expected.length) return false;
  return log.every((entry, index) => {
    const [at, kind, value] = expected[index];
    return entry.at === at && entry.kind === kind && (value === undefined || entry.value === value);
  });
}

/** Every displayed stage must remain visible >= the minimum beat. */
function minBeatsHold(log: LogEntry[]): boolean {
  const stages = log.filter((entry) => entry.kind === 'stage');
  for (let i = 0; i < stages.length; i++) {
    const shownAt = stages[i].at;
    const next = log.find((entry) => entry.at > shownAt && (entry.kind === 'stage' || entry.kind === 'text'));
    if (next && next.at - shownAt < STAGE_MIN_VISIBLE_MS) return false;
  }
  return true;
}

const MIN = STAGE_MIN_VISIBLE_MS;

function scenarioBackToBackBurst(): void {
  console.log('scenario: back-to-back stages + content + done in one read');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(5);
  pacer.serverStage('thinking');
  clock.advanceTo(6);
  pacer.serverStage('formulating');
  clock.advanceTo(7);
  pacer.delta('Hello');
  clock.advanceTo(8);
  pacer.delta(' there');
  pacer.done();
  clock.advanceTo(10_000);
  check(
    'labels pace out, text lands after the last beat, done rides the flush',
    timelineEquals(log, [
      [0, 'stage', 'searching'],
      [MIN, 'stage', 'thinking'],
      [2 * MIN, 'stage', 'formulating'],
      [3 * MIN, 'text', 'Hello there'],
      [3 * MIN, 'finalize'],
    ]),
    fmt(log),
  );
  check('every displayed label held its minimum beat', minBeatsHold(log));
  check('no stray timers left armed', clock.pendingCount() === 0, `${clock.pendingCount()} pending`);
}

function scenarioLastBeatProtectsText(): void {
  console.log('scenario: empty queue, text arrives mid-beat of the last label');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(1200);
  pacer.serverStage('thinking'); // beat long elapsed -> displays immediately
  clock.advanceTo(2000);
  pacer.serverStage('formulating'); // 800ms after thinking -> immediate
  clock.advanceTo(2050);
  pacer.delta('Answer.');
  clock.advanceTo(10_000);
  pacer.done();
  check(
    'text waited out the remainder of the formulating beat',
    timelineEquals(log, [
      [0, 'stage', 'searching'],
      [1200, 'stage', 'thinking'],
      [2000, 'stage', 'formulating'],
      [2000 + MIN, 'text', 'Answer.'],
      [10_000, 'finalize'],
    ]),
    fmt(log),
  );
  check('every displayed label held its minimum beat', minBeatsHold(log));
}

function scenarioBroadenedNarration(): void {
  console.log('scenario: broadened turn repeats searching/thinking; dedup + post-gate ignore');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(100);
  pacer.serverStage('thinking');
  pacer.serverStage('thinking'); // consecutive duplicate dedups
  clock.advanceTo(3000);
  pacer.serverStage('searching'); // broadened second pass
  clock.advanceTo(3100);
  pacer.serverStage('thinking');
  clock.advanceTo(9000);
  pacer.serverStage('formulating');
  clock.advanceTo(9050);
  pacer.delta('Grounded answer');
  clock.advanceTo(9800);
  pacer.delta(' continues'); // gate is open -> immediate passthrough
  pacer.serverStage('searching'); // post-gate stage must be ignored
  clock.advanceTo(12_000);
  pacer.done();
  check(
    'labels follow arrival order with beats, text gates on the final beat',
    timelineEquals(log, [
      [0, 'stage', 'searching'],
      [MIN, 'stage', 'thinking'],
      [3000, 'stage', 'searching'],
      [3700, 'stage', 'thinking'],
      [9000, 'stage', 'formulating'],
      [9000 + MIN, 'text', 'Grounded answer'],
      [9800, 'text', ' continues'],
      [12_000, 'finalize'],
    ]),
    fmt(log),
  );
  check('every displayed label held its minimum beat', minBeatsHold(log));
}

function scenarioFallbackWalk(): void {
  console.log('scenario: no server stages — the timed fallback narrates');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(FALLBACK_FORMULATING_AT_MS + 500);
  pacer.delta('Slow answer');
  clock.advanceTo(FALLBACK_FORMULATING_AT_MS + 5000);
  pacer.done();
  check(
    'fallback labels walk the progression and text respects the last beat',
    timelineEquals(log, [
      [0, 'stage', 'searching'],
      [FALLBACK_THINKING_AT_MS, 'stage', 'thinking'],
      [FALLBACK_FORMULATING_AT_MS, 'stage', 'formulating'],
      [FALLBACK_FORMULATING_AT_MS + MIN, 'text', 'Slow answer'],
      [FALLBACK_FORMULATING_AT_MS + 5000, 'finalize'],
    ]),
    fmt(log),
  );

  console.log('scenario: a real server stage disarms the fallback');
  const real = makeHarness();
  real.pacer.start();
  real.clock.advanceTo(800);
  real.pacer.serverStage('thinking');
  real.clock.advanceTo(FALLBACK_FORMULATING_AT_MS + 1000);
  const fallbackFired = real.log.some(
    (entry) => entry.kind === 'stage' && entry.value === 'formulating',
  );
  check('no fallback formulating after a real stage arrived', !fallbackFired, fmt(real.log));
}

function scenarioEarlyContentNoStages(): void {
  console.log('scenario: content before any further narration flushes after searching\u2019s beat');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(50);
  pacer.delta('Instant');
  pacer.done();
  clock.advanceTo(5000);
  check(
    'held text and deferred done both land exactly at the first beat boundary',
    timelineEquals(log, [
      [0, 'stage', 'searching'],
      [MIN, 'text', 'Instant'],
      [MIN, 'finalize'],
    ]),
    fmt(log),
  );
  check('finalize never precedes the text it gated', log.findIndex((e) => e.kind === 'finalize') > log.findIndex((e) => e.kind === 'text'));
  check('fallback timers were cancelled at gate open', clock.pendingCount() === 0, `${clock.pendingCount()} pending`);
}

function scenarioStopFastForwards(): void {
  console.log('scenario: Stop fast-forwards held text');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(20);
  pacer.serverStage('thinking');
  clock.advanceTo(60);
  pacer.delta('partial ans');
  clock.advanceTo(200);
  const wasDone = pacer.finish();
  check('finish() reports the stream had NOT completed', wasDone === false);
  check(
    'held text flushed immediately at Stop, beats abandoned',
    timelineEquals(log, [
      [0, 'stage', 'searching'],
      [200, 'text', 'partial ans'],
    ]),
    fmt(log),
  );
  clock.advanceTo(10_000);
  check('nothing fires after finish()', log.length === 2, fmt(log));

  console.log('scenario: Stop after done-with-held-text is a completed reply');
  const done = makeHarness();
  done.pacer.start();
  done.clock.advanceTo(30);
  done.pacer.delta('Full answer');
  done.pacer.done();
  done.clock.advanceTo(250); // gate still closed (searching's beat runs to 700)
  const wasDone2 = done.pacer.finish();
  check('finish() reports done had arrived', wasDone2 === true);
  check(
    'flush and finalize both fired at the Stop moment',
    timelineEquals(done.log, [
      [0, 'stage', 'searching'],
      [250, 'text', 'Full answer'],
      [250, 'finalize'],
    ]),
    fmt(done.log),
  );
}

function scenarioCancelGoesSilent(): void {
  console.log('scenario: cancel() drops held text and timers silently');
  const { clock, log, pacer } = makeHarness();
  pacer.start();
  clock.advanceTo(40);
  pacer.serverStage('thinking');
  pacer.delta('will never render');
  pacer.cancel();
  clock.advanceTo(10_000);
  pacer.delta('late');
  pacer.done();
  check(
    'only the initial searching label ever rendered',
    timelineEquals(log, [[0, 'stage', 'searching']]),
    fmt(log),
  );
  check('no timers survive cancel()', clock.pendingCount() === 0, `${clock.pendingCount()} pending`);
}

function main(): void {
  console.log('StagePacer timeline verification (virtual clock)\n');
  scenarioBackToBackBurst();
  scenarioLastBeatProtectsText();
  scenarioBroadenedNarration();
  scenarioFallbackWalk();
  scenarioEarlyContentNoStages();
  scenarioStopFastForwards();
  scenarioCancelGoesSilent();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll StagePacer checks passed');
}

main();
