/**
 * Toast notification layer — hermetic checks for the pieces a browser pass
 * can't pin precisely: the sound gate, the two cue specs, the progress
 * variant's lifecycle, and the store's eviction rules.
 *
 * Runs under Node with no DOM and no audio stack: lib/toast-sound.ts takes a
 * recording AudioContext and an in-memory preference storage through
 * __setToastSoundTestHooks, and hooks/use-toast.ts exposes test-only
 * reset/snapshot helpers.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:toasts
 */

import {
  __setToastSoundTestHooks,
  isToastSoundEnabled,
  playToastCue,
  setToastSoundEnabled,
  subscribeToastSound,
  toastCue,
  unlockToastAudio,
  type ToastAudioContext,
} from '@/lib/toast-sound';
import {
  __getToastStateForTests,
  __resetToastStoreForTests,
  __setToastTimingForTests,
  progressToast,
  toast,
} from '@/hooks/use-toast';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same code paths, test-sized real-time waits (see use-toast.ts).
__setToastTimingForTests({ removeDelayMs: 80, progressLingerMs: 150 });

// --- tiny harness -----------------------------------------------------------

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n== ${title}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fakes -------------------------------------------------------------------

interface RecordedOscillator {
  type: string;
  recordedFrequency: number;
  started: boolean;
  stopped: boolean;
}

function makeFakeAudio(initialState = 'running') {
  const oscillators: RecordedOscillator[] = [];
  let resumes = 0;
  const ctx: ToastAudioContext = {
    currentTime: 0,
    state: initialState,
    resume: () => {
      resumes += 1;
      ctx.state = 'running';
      return undefined;
    },
    destination: {},
    createOscillator() {
      const record: RecordedOscillator = {
        type: 'sine',
        recordedFrequency: 0,
        started: false,
        stopped: false,
      };
      oscillators.push(record);
      return {
        get type() {
          return record.type;
        },
        set type(value: string) {
          record.type = value;
        },
        frequency: {
          setValueAtTime(value: number) {
            record.recordedFrequency = value;
            return undefined;
          },
        },
        connect: () => undefined,
        start: () => {
          record.started = true;
        },
        stop: () => {
          record.stopped = true;
        },
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
      };
    },
  };
  return {
    ctx,
    oscillators,
    resumeCount: () => resumes,
  };
}

function makeFakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

/** Fresh audio + storage fakes wired into the sound layer. */
function freshSoundRig(initialState = 'running') {
  const audio = makeFakeAudio(initialState);
  const storage = makeFakeStorage();
  __setToastSoundTestHooks({ contextFactory: () => audio.ctx, storage });
  return { audio, storage };
}

async function main() {
  // --- cue specs -------------------------------------------------------------
  section('Cue specs: the ding and the failure tone stay distinct');
  const success = toastCue('success');
  const failure = toastCue('failure');
  check('success cue is a three-partial bell', success.notes.length === 3);
  check(
    'success cue is all sine partials above 900 Hz',
    success.notes.every((note) => note.wave === 'sine' && note.frequency > 900),
  );
  check('failure cue is two notes', failure.notes.length === 2);
  check(
    'failure cue sits low (under 400 Hz) on triangle waves',
    failure.notes.every((note) => note.wave === 'triangle' && note.frequency < 400),
  );
  check(
    'failure cue steps down over time',
    failure.notes[1]!.startAt > failure.notes[0]!.startAt &&
      failure.notes[1]!.frequency < failure.notes[0]!.frequency,
  );
  check(
    'no frequency is shared between the cues',
    !success.notes.some((note) => failure.notes.some((other) => other.frequency === note.frequency)),
  );
  check(
    'both cues stay ambient (peak gain ≤ 0.06)',
    [...success.notes, ...failure.notes].every((note) => note.peak <= 0.06),
  );

  // --- preference gate ---------------------------------------------------------
  section('Persisted sound preference');
  {
    const { storage } = freshSoundRig();
    check('sound defaults ON with nothing persisted', isToastSoundEnabled() === true);
    const seen: boolean[] = [];
    const unsubscribe = subscribeToastSound((enabled) => seen.push(enabled));
    setToastSoundEnabled(false);
    check('turning sound off persists "off"', storage.map.get('thinnr-hq-toast-sound') === 'off');
    check('gate reads back off', isToastSoundEnabled() === false);
    setToastSoundEnabled(true);
    check('turning sound on persists "on"', storage.map.get('thinnr-hq-toast-sound') === 'on');
    check('subscribers heard both flips in order', JSON.stringify(seen) === '[false,true]');
    unsubscribe();
    setToastSoundEnabled(false);
    check('unsubscribed listener hears nothing more', seen.length === 2);
  }

  // --- playToastCue --------------------------------------------------------------
  section('playToastCue schedules through the gate');
  {
    const { audio } = freshSoundRig();
    check('success cue reports played', playToastCue('success') === true);
    check('success cue schedules 3 oscillators', audio.oscillators.length === 3);
    check(
      'scheduled oscillators match the spec',
      audio.oscillators.every(
        (osc, index) =>
          osc.started &&
          osc.stopped &&
          osc.type === success.notes[index]!.wave &&
          osc.recordedFrequency === success.notes[index]!.frequency,
      ),
    );
    check('failure cue reports played', playToastCue('failure') === true);
    check('failure cue adds 2 oscillators', audio.oscillators.length === 5);
    setToastSoundEnabled(false);
    check('gate off: cue reports silent', playToastCue('success') === false);
    check('gate off: nothing scheduled', audio.oscillators.length === 5);
  }
  {
    __setToastSoundTestHooks({ contextFactory: () => null, storage: makeFakeStorage() });
    check('no audio stack: cue degrades to silent false', playToastCue('success') === false);
  }
  {
    const { audio } = freshSoundRig('suspended');
    check('suspended context: cue reports attempted', playToastCue('success') === true);
    check('suspended context is resumed', audio.resumeCount() === 1);
    check('nothing schedules while still suspended', audio.oscillators.length === 0);
    await Promise.resolve();
    check('cue lands once the resume settles into running', audio.oscillators.length === 3);
  }
  {
    // Autoplay hard-block: resume() rejects — stays silent, never throws.
    const audio = makeFakeAudio('suspended');
    audio.ctx.resume = () => Promise.reject(new Error('autoplay blocked'));
    __setToastSoundTestHooks({ contextFactory: () => audio.ctx, storage: makeFakeStorage() });
    check('hard-blocked context: cue still reports attempted', playToastCue('success') === true);
    await Promise.resolve();
    await Promise.resolve();
    check('hard-blocked context: nothing ever schedules', audio.oscillators.length === 0);
  }
  {
    // First-gesture unlock helper (the document listeners call this).
    const { audio } = freshSoundRig('suspended');
    unlockToastAudio();
    check('unlock resumes a suspended context', audio.resumeCount() === 1);
    check('unlock alone plays nothing', audio.oscillators.length === 0);
    unlockToastAudio();
    check('unlock is a no-op once running', audio.resumeCount() === 1);
  }

  // --- toast() variant wiring ---------------------------------------------------
  section('toast(): sound and duration ride the variant');
  {
    const { audio } = freshSoundRig();
    __resetToastStoreForTests();
    toast({ variant: 'success', title: 'Saved' });
    check('success toast rings the ding exactly once', audio.oscillators.length === 3);
    toast({ variant: 'destructive', title: 'Failed' });
    check('destructive toast plays the failure tone', audio.oscillators.length === 5);
    toast({ title: 'Just so you know' });
    check('default toast stays silent', audio.oscillators.length === 5);

    const state = __getToastStateForTests();
    const destructive = state.toasts.find((t) => t.variant === 'destructive');
    const successToast = state.toasts.find((t) => t.variant === 'success');
    check('destructive toasts linger 8s by default', destructive?.duration === 8000);
    check('success toasts keep the provider default duration', successToast?.duration === undefined);
    toast({ variant: 'destructive', title: 'Short-lived', duration: 3000 });
    const overridden = __getToastStateForTests().toasts.find((t) => t.title === 'Short-lived');
    check('caller duration override wins', overridden?.duration === 3000);

    const baseline = audio.oscillators.length;
    setToastSoundEnabled(false);
    toast({ variant: 'success', title: 'Silent save' });
    check('preference off silences success toasts too', audio.oscillators.length === baseline);
  }

  // --- progress variant ------------------------------------------------------------
  section('progressToast(): lifecycle, clamps, end states');
  const rig = freshSoundRig();
  __resetToastStoreForTests();

  const upload = progressToast({ title: 'Uploading video', description: 'training.mp4' });
  {
    const t = __getToastStateForTests().toasts.find((item) => item.id === upload.id);
    check('starts active at 0%', t?.progress?.state === 'active' && t.progress.value === 0);
    check('stays up while active (Infinity duration)', t?.duration === Infinity);
    check('creating a progress toast makes no sound', rig.audio.oscillators.length === 0);
  }
  upload.setProgress(37.4);
  check(
    'progress rounds to whole percent',
    __getToastStateForTests().toasts.find((t) => t.id === upload.id)?.progress?.value === 37,
  );
  upload.setProgress(-5);
  check(
    'progress clamps below at 0',
    __getToastStateForTests().toasts.find((t) => t.id === upload.id)?.progress?.value === 0,
  );
  upload.setProgress(150);
  check(
    'progress clamps above at 100',
    __getToastStateForTests().toasts.find((t) => t.id === upload.id)?.progress?.value === 100,
  );
  upload.setProgress(Number.NaN);
  check(
    'non-finite updates are ignored',
    __getToastStateForTests().toasts.find((t) => t.id === upload.id)?.progress?.value === 100,
  );

  const stalled = progressToast({ title: 'Syncing library' });
  stalled.setProgress(42);

  upload.done({ title: 'Upload complete', description: 'training.mp4 is ready.' });
  const doneSerial = __getToastStateForTests().announcement?.serial;
  {
    const t = __getToastStateForTests().toasts.find((item) => item.id === upload.id);
    check('done() morphs to the success variant', t?.variant === 'success');
    check('done() pins the bar at 100/done', t?.progress?.state === 'done' && t.progress.value === 100);
    check('done() rings the ding', rig.audio.oscillators.length === 3);
    check(
      'done() announces once for screen readers',
      __getToastStateForTests().announcement?.message === 'Upload complete. training.mp4 is ready.',
    );
    check('done() keeps the toast visible for the linger window', t?.open === true);
  }
  upload.done();
  upload.fail({ title: 'Should be ignored' });
  upload.setProgress(10);
  {
    const t = __getToastStateForTests().toasts.find((item) => item.id === upload.id);
    check('settle is idempotent: still done at 100', t?.progress?.state === 'done' && t.progress.value === 100);
    check('settle is idempotent: no extra sound', rig.audio.oscillators.length === 3);
    check('settle is idempotent: no re-announcement', __getToastStateForTests().announcement?.serial === doneSerial);
  }

  stalled.fail({ description: 'The network dropped mid-transfer.' });
  {
    const t = __getToastStateForTests().toasts.find((item) => item.id === stalled.id);
    check('fail() morphs to the destructive variant', t?.variant === 'destructive');
    check('fail() freezes the bar where it stopped', t?.progress?.state === 'failed' && t.progress.value === 42);
    check('fail() plays the failure tone', rig.audio.oscillators.length === 5);
    check(
      'fail() announces with a failed title',
      (__getToastStateForTests().announcement?.message ?? '').includes('failed'),
    );
    check('fail() re-announces on a fresh serial', __getToastStateForTests().announcement?.serial === (doneSerial ?? 0) + 1);
  }

  console.log('   ... waiting out the test-sized done-linger window');
  await sleep(400);
  {
    const doneToast = __getToastStateForTests().toasts.find((item) => item.id === upload.id);
    const failedToast = __getToastStateForTests().toasts.find((item) => item.id === stalled.id);
    check('finished progress toast dismisses itself', doneToast === undefined || doneToast.open === false);
    check('failed progress toast stays until closed', failedToast?.open === true);
  }
  await sleep(250);
  check(
    'dismissed progress toast leaves the store',
    __getToastStateForTests().toasts.every((item) => item.id !== upload.id),
  );

  // --- eviction ---------------------------------------------------------------------
  section('Stacking: three visible, live progress never evicted');
  freshSoundRig();
  __resetToastStoreForTests();
  {
    toast({ title: 'one' });
    toast({ title: 'two' });
    toast({ title: 'three' });
    toast({ title: 'four' });
    const titles = __getToastStateForTests().toasts.map((t) => t.title);
    check('limit holds at three toasts', titles.length === 3);
    check('oldest plain toast is evicted first', !titles.includes('one') && titles.includes('four'));
  }
  __resetToastStoreForTests();
  {
    const pinned = progressToast({ title: 'Long upload' });
    toast({ title: 'a' });
    toast({ title: 'b' });
    toast({ title: 'c' });
    const state = __getToastStateForTests();
    check('active progress toast survives a full stack', state.toasts.some((t) => t.id === pinned.id));
    check('eviction skips over the pinned toast to the next oldest', !state.toasts.some((t) => t.title === 'a'));
    pinned.done({ title: 'Long upload finished' });
    toast({ title: 'd' });
    const after = __getToastStateForTests();
    check('settled progress toast is evictable again', !after.toasts.some((t) => t.id === pinned.id));
  }

  // --- rollout contract ---------------------------------------------------------------
  // Static source assertions pinning the reviewer-flagged VideoEditor paths to
  // their required variants (regressing one of these silences a real action).
  section('Rollout contract: VideoEditor upload & thumbnail feedback');
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../src/pages/admin/training/VideoEditor.tsx'), 'utf8');
    check(
      'hosted upload rides a bottom-right progress toast',
      source.includes("progressToast({ title: 'Uploading video'"),
    );
    check(
      'upload success settles the progress toast with the ding',
      /\.done\(\{\s*title: 'Video uploaded'/.test(source),
    );
    check(
      'upload failure settles the progress toast as a failure that stays',
      /\.fail\(\{ title: 'Upload failed'/.test(source),
    );
    check(
      'rejected video selection raises a destructive toast',
      source.includes(`variant: 'destructive', title: "Can't use that video file"`),
    );
    check(
      'thumbnail upload failure raises a destructive toast',
      source.includes("variant: 'destructive', title: 'Thumbnail upload failed'"),
    );
    check(
      'rejected thumbnail selection raises a destructive toast',
      source.includes(`variant: 'destructive', title: "Can't use that image"`),
    );
  }

  __resetToastStoreForTests();
  __setToastSoundTestHooks();

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('verify-toasts: PASS');
  process.exit(0);
}

main().catch((error) => {
  console.error('verify-toasts crashed:', error);
  process.exit(1);
});
