/**
 * GuidedPhotoSession — the hands-free progress photo flow behind
 * /guided-photos: prop the phone on the floor, step back about 6 feet,
 * and the app shoots Front, Side, and Back automatically.
 *
 * Stages:
 *  - setup: floor-placement instructions (persisted "hide" preference) and
 *    the three posing examples. Returning users who hid the instructions
 *    skip straight to capture — safe, because nothing shoots until the
 *    line-up gate clears.
 *  - positioning (per angle): the live LINE-UP stage. A huge vertical
 *    level bar over the camera preview renders the CONTINUOUS smoothed
 *    lean angle from the motion sensor (sub-degree, no steps); green only
 *    inside the tight 12–18° lean-back band for a floor-propped phone —
 *    tipped toward the floor can never read green. Meanwhile a cheap
 *    on-device check — no AI, no network — reads tiny probe frames about
 *    once a second, compares them against an adaptive background, and
 *    coaches with one huge instruction at a time, on screen and out loud.
 *    Only when tilt, framing, and light ALL hold green for the steady
 *    window (progress fills the band) does the countdown start itself;
 *    losing the lock resets the hold with a falling cue. If the gate stays
 *    unsatisfied long enough, a plain "Start anyway" appears so nobody is
 *    stranded — imperfect shots still get flagged at review. When probing
 *    is unavailable the gate runs on tilt alone, and with no tilt signal
 *    either, a plain timer keeps the hands-free promise.
 *  - countdown: a BIG 7-second count — numeral dead center, dimmed outline
 *    behind it — with a tick sound and haptic each second and a distinct
 *    capture tone at zero, when the front camera auto-takes the shot.
 *  - review: three labeled shots with per-angle reshoot checkboxes —
 *    reshoot re-runs positioning + countdown for only the chosen angles;
 *    unselected shots are kept. Save silently compresses and uploads the
 *    set; a failed upload keeps every shot on-device with a clear
 *    retryable error.
 *
 * Camera permission denied (or a camera that fails to start) swaps to the
 * same in-surface fallback style as the meal camera. On web the identical
 * flow runs against a simulated feed: a scripted lean settling into the
 * band and synthetic probe frames, both through the SAME engine — so the
 * whole line-up, gate included, demos inside the fit-to-iPhone shell.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { DeviceMotion } from 'expo-sensors';
import { Asset } from 'expo-asset';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';
import { BodyOutline } from '@/components/patient/BodyOutline';
import { TiltLevelBar } from '@/components/patient/TiltLevelBar';
import { GUIDED_POSE_IMAGES } from '@/data/guided-photo-images';
import { CAPTURE_TONE_SOUND, HOLD_LOST_SOUND, TICK_SOUND } from '@/data/guided-photo-sounds';
import { ENROLLMENT_DAYS, TODAY_KEY } from '@/data/patient-data';
import {
  COUNTDOWN_SECONDS,
  GUIDED_ANGLES,
  GUIDED_ANGLE_LABELS,
  getGuidedEscapeMs,
  getGuidedGateTickMs,
  getGuidedHoldMs,
  getGuidedProbeIntervalMs,
  getGuidedTickIntervalMs,
  HIDE_INSTRUCTIONS_KEY,
  type GuidedAngle,
  type GuidedSessionOutcome,
  type GuidedShot,
} from '@/lib/guided-photos';
import {
  createSubjectDetector,
  makeSimulatedFrame,
  type LumaFrame,
  type PositioningReading,
} from '@/lib/photo-detection';
import { createSteadyHold, lineupStatus, type LineupStatus } from '@/lib/lineup';
import { LINEUP_ANNOUNCEMENTS, LINEUP_HINTS, speakCue, stopCues } from '@/lib/session-feedback';
import { createLeanSmoother, leanBackDegrees, simulatedLeanAt } from '@/lib/tilt';
import { probeCameraFrame } from '@/lib/photo-probe';
import { uploadGuidedShots } from '@/lib/progress-photo-upload';

/** Scrim behind floating controls over the live preview. */
const CONTROL_SCRIM = 'rgba(16, 22, 31, 0.42)';
/** Deeper scrim behind full-width text bands. */
const BAND_SCRIM = 'rgba(14, 20, 29, 0.62)';
/** Simulated-feed backdrop on web, where live capture is native-only. */
const DEMO_FEED_BG = '#232E3C';

type Stage =
  | { kind: 'setup' }
  | { kind: 'positioning'; angle: GuidedAngle }
  | { kind: 'countdown'; angle: GuidedAngle; secondsLeft: number }
  | { kind: 'review' }
  | { kind: 'saving' };

/** What the line-up UI renders each gate tick. */
interface LineupView {
  status: LineupStatus | null;
  holdProgress: number;
  leanDeg: number | null;
}

function announce(message: string): void {
  AccessibilityInfo.announceForAccessibility(message);
}

// ---------------------------------------------------------------------------
// Persisted "hide instructions" preference (web localStorage / native
// AsyncStorage — the same storage split as PatientContext).
// ---------------------------------------------------------------------------

async function readHideInstructions(): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      return globalThis.localStorage?.getItem(HIDE_INSTRUCTIONS_KEY) === '1';
    }
    return (await AsyncStorage.getItem(HIDE_INSTRUCTIONS_KEY)) === '1';
  } catch {
    return false;
  }
}

async function writeHideInstructions(hide: boolean): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      const storage = globalThis.localStorage;
      if (!storage) return;
      if (hide) storage.setItem(HIDE_INSTRUCTIONS_KEY, '1');
      else storage.removeItem(HIDE_INSTRUCTIONS_KEY);
      return;
    }
    if (hide) await AsyncStorage.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    else await AsyncStorage.removeItem(HIDE_INSTRUCTIONS_KEY);
  } catch {
    // The preference is a nicety — the session works without persistence.
  }
}

// ---------------------------------------------------------------------------
// Session sounds (expo-audio). Failures degrade quietly — haptics and
// spoken announcements still carry the rhythm.
// ---------------------------------------------------------------------------

function useSessionSounds(): {
  playTick: () => void;
  playTone: () => void;
  playHoldLost: () => void;
} {
  const tickRef = useRef<AudioPlayer | null>(null);
  const toneRef = useRef<AudioPlayer | null>(null);
  const holdLostRef = useRef<AudioPlayer | null>(null);

  useEffect(() => {
    try {
      void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
      tickRef.current = createAudioPlayer(TICK_SOUND);
      toneRef.current = createAudioPlayer(CAPTURE_TONE_SOUND);
      holdLostRef.current = createAudioPlayer(HOLD_LOST_SOUND);
    } catch {
      tickRef.current = null;
      toneRef.current = null;
      holdLostRef.current = null;
    }
    return () => {
      for (const ref of [tickRef, toneRef, holdLostRef]) {
        try {
          ref.current?.remove();
        } catch {}
        ref.current = null;
      }
    };
  }, []);

  const playFrom = (ref: React.MutableRefObject<AudioPlayer | null>) => {
    try {
      const player = ref.current;
      if (!player) return;
      void player.seekTo(0);
      player.play();
    } catch {}
  };

  const playTick = useCallback(() => playFrom(tickRef), []);
  const playTone = useCallback(() => playFrom(toneRef), []);
  const playHoldLost = useCallback(() => playFrom(holdLostRef), []);

  return { playTick, playTone, playHoldLost };
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Announced inline error — alert role, live region, explicit iOS speak. */
function ErrorNote({ text, testID }: { text: string; testID?: string }) {
  const colors = useColors();
  useEffect(() => {
    if (Platform.OS === 'ios') announce(text);
  }, [text]);
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.errorNote, { backgroundColor: colors.paperCard, borderColor: colors.riskText }]}
    >
      <Feather name="alert-triangle" size={14} color={colors.riskText} />
      <Text style={[styles.errorNoteText, { color: colors.riskText }]}>{text}</Text>
    </View>
  );
}

/** Web stand-in for the live camera: a quiet, obviously-simulated feed. */
function DemoFeed({ angle }: { angle: GuidedAngle | null }) {
  return (
    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: DEMO_FEED_BG }]}>
      {angle ? (
        <Image
          source={GUIDED_POSE_IMAGES[angle]}
          style={styles.demoGhost}
          contentFit="contain"
          transition={200}
        />
      ) : null}
      <View style={styles.demoBadge} pointerEvents="none">
        <Feather name="video" size={11} color="#DDE5EF" />
        <Text style={styles.demoBadgeText}>SIMULATED CAMERA</Text>
      </View>
    </View>
  );
}

interface GuidedPhotoSessionProps {
  /** Receives the outcome (photos saved) or null when closed without saving. */
  onSettle: (outcome: GuidedSessionOutcome | null) => void;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export function GuidedPhotoSession({ onSettle }: GuidedPhotoSessionProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [permission, requestPermission] = useCameraPermissions();
  const { playTick, playTone, playHoldLost } = useSessionSounds();

  const [stage, setStage] = useState<Stage>({ kind: 'setup' });
  const [shots, setShots] = useState<Partial<Record<GuidedAngle, GuidedShot>>>({});
  const [probesAvailable, setProbesAvailable] = useState<boolean | null>(null);
  const [lineup, setLineup] = useState<LineupView>({ status: null, holdProgress: 0, leanDeg: null });
  const [showEscape, setShowEscape] = useState(false);
  // Tilt determination: true once ANY motion reading has arrived, false
  // once the sensor path is known dead (unavailable, denied, erroring, or
  // silent past the stall window), null while undetermined. The gate may
  // only lean on tilt when this is true — and it can NEVER go green
  // without a live angle (see lib/lineup.ts).
  const [tiltAvailable, setTiltAvailable] = useState<boolean | null>(null);
  const [reshootSelection, setReshootSelection] = useState<Set<GuidedAngle>>(new Set());
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [hidePref, setHidePref] = useState<boolean | null>(null);
  const [mountError, setMountError] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  const cameraRef = useRef<CameraView | null>(null);
  const detectorRef = useRef(createSubjectDetector());
  const queueRef = useRef<GuidedAngle[]>([]);
  const uploadedRef = useRef(new Map<GuidedAngle, string>());
  const lastStatusRef = useRef<LineupStatus | null>(null);
  const readingRef = useRef<PositioningReading | null>(null);
  const holdRef = useRef(createSteadyHold());
  const leanSmootherRef = useRef(createLeanSmoother());
  const leanDegRef = useRef<number | null>(null);
  const leanAnimRef = useRef(new Animated.Value(0));
  const simStepRef = useRef(0);
  const simLeanElapsedRef = useRef(0);
  const probeBusyRef = useRef(false);
  const probeMissRef = useRef(0);
  const captureBusyRef = useRef(false);
  const askedRef = useRef(false);
  const autoStartedRef = useRef(false);
  const fallbackAnnouncedRef = useRef(false);
  const screenReaderOnRef = useRef(false);
  // Hide-instructions value as HYDRATED from storage. Auto-start keys off
  // this, not live state — ticking the checkbox during setup must persist
  // the preference without launching the session out from under the user.
  const initialHidePrefRef = useRef<boolean | null>(null);
  const doneRef = useRef(false);

  const isWeb = Platform.OS === 'web';
  const cameraGranted = isWeb || permission?.granted === true;
  const cameraMode = !isWeb && cameraGranted && !mountError;
  const fallbackMode =
    !isWeb && (permission?.status === 'denied' || (cameraGranted && mountError));

  const finish = useCallback(
    (outcome: GuidedSessionOutcome | null) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onSettle(outcome);
    },
    [onSettle],
  );

  // Ask for the camera once on arrival — only while still undetermined; a
  // previous denial is respected and lands on the fallback view instead.
  useEffect(() => {
    if (isWeb || !permission || askedRef.current) return;
    if (permission.status !== 'undetermined') return;
    askedRef.current = true;
    void requestPermission();
  }, [isWeb, permission, requestPermission]);

  useEffect(() => {
    void readHideInstructions().then(value => {
      if (initialHidePrefRef.current === null) initialHidePrefRef.current = value;
      setHidePref(value);
    });
  }, []);

  // Spoken cues go quiet while a screen reader runs — VoiceOver/TalkBack
  // already reads every announcement.
  useEffect(() => {
    let disposed = false;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then(enabled => {
        if (!disposed) screenReaderOnRef.current = enabled;
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', enabled => {
      screenReaderOnRef.current = enabled;
    });
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, []);

  useEffect(() => () => stopCues(), []);

  const startRun = useCallback(
    (angles: readonly GuidedAngle[]) => {
      queueRef.current = [...angles];
      detectorRef.current.resetHold();
      holdRef.current.reset();
      lastStatusRef.current = null;
      readingRef.current = null;
      setCaptureError(null);
      setShowEscape(false);
      if (isWeb) {
        // Each web run replays the scripted lean settle from the top.
        simLeanElapsedRef.current = 0;
        leanSmootherRef.current.reset();
        leanDegRef.current = null;
        setTiltAvailable(null);
      }
      setLineup({ status: null, holdProgress: 0, leanDeg: leanDegRef.current });
      const first = queueRef.current[0];
      if (!first) return;
      const message = `${GUIDED_ANGLE_LABELS[first]} photo first. Step back about six feet and stand in the outline.`;
      announce(message);
      speakCue(message, screenReaderOnRef.current);
      setStage({ kind: 'positioning', angle: first });
    },
    [isWeb],
  );

  // Returning users who hid the instructions skip straight to capture —
  // nothing shoots until the line-up gate (or its escape button) says so.
  useEffect(() => {
    if (autoStartedRef.current || initialHidePrefRef.current !== true) return;
    if (stage.kind !== 'setup' || fallbackMode) return;
    if (!isWeb && !cameraGranted) return;
    autoStartedRef.current = true;
    startRun(GUIDED_ANGLES);
  }, [hidePref, stage, fallbackMode, isWeb, cameraGranted, startRun]);

  const beginCountdown = useCallback((angle: GuidedAngle) => {
    setStage(current => {
      if (current.kind !== 'positioning' || current.angle !== angle) return current;
      const message = `In position. Taking the ${GUIDED_ANGLE_LABELS[angle].toLowerCase()} photo in ${COUNTDOWN_SECONDS} seconds. Hold still.`;
      announce(message);
      speakCue(message, screenReaderOnRef.current);
      return { kind: 'countdown', angle, secondsLeft: COUNTDOWN_SECONDS };
    });
  }, []);

  // ── Live lean angle ───────────────────────────────────────────────────
  // The smoothed signed lean lives in a ref (the gate samples it) and in
  // an Animated value (the bar's indicator glides without re-rendering
  // per sample).
  const animateLean = useCallback((deg: number) => {
    Animated.timing(leanAnimRef.current, {
      toValue: deg,
      duration: 90,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);

  // Native: DeviceMotion at 50 ms. Gravity carries the unambiguous sign —
  // see lib/tilt.ts for why beta alone reads face-down as leaned-back.
  useEffect(() => {
    if (stage.kind !== 'positioning' || isWeb) return;
    let cancelled = false;
    let subscription: { remove(): void } | null = null;
    (async () => {
      try {
        const available = await DeviceMotion.isAvailableAsync();
        if (cancelled) return;
        if (!available) {
          setTiltAvailable(false);
          return;
        }
        const motionPermission = await DeviceMotion.requestPermissionsAsync();
        if (cancelled) return;
        if (!motionPermission.granted) {
          setTiltAvailable(false);
          return;
        }
        DeviceMotion.setUpdateInterval(50);
        subscription = DeviceMotion.addListener(measurement => {
          const lean = leanBackDegrees({
            gravityY: measurement.accelerationIncludingGravity?.y ?? null,
            gravityZ: measurement.accelerationIncludingGravity?.z ?? null,
          });
          if (lean === null) return;
          const smoothed = leanSmootherRef.current.push(lean);
          leanDegRef.current = smoothed;
          setTiltAvailable(true);
          animateLean(smoothed);
        });
      } catch {
        // Motion stack broken — tilt is unavailable, never guessed. The
        // gate stays shut; only the explicit escape can start capture.
        if (!cancelled) setTiltAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [stage.kind, isWeb, animateLean]);

  // Web: the scripted lean settles into the band through the SAME
  // smoothing pipeline. Virtual time advances on the probe-interval scale
  // so shortened demo/suite knobs play the settle proportionally faster.
  useEffect(() => {
    if (stage.kind !== 'positioning' || !isWeb) return;
    const timer = setInterval(() => {
      simLeanElapsedRef.current += 50 * (1000 / getGuidedProbeIntervalMs());
      const smoothed = leanSmootherRef.current.push(simulatedLeanAt(simLeanElapsedRef.current));
      leanDegRef.current = smoothed;
      setTiltAvailable(true);
      animateLean(smoothed);
    }, 50);
    return () => clearInterval(timer);
  }, [stage.kind, isWeb, animateLean]);

  // ── Positioning probe loop ────────────────────────────────────────────
  // ~1 Hz tiny frames through the adaptive detector; web feeds synthetic
  // frames through the SAME code path so the demo behaves like the phone.
  useEffect(() => {
    if (stage.kind !== 'positioning') return;
    let disposed = false;
    const timer = setInterval(() => {
      if (disposed || probeBusyRef.current) return;
      probeBusyRef.current = true;
      void (async () => {
        try {
          let frame: LumaFrame | null = null;
          if (isWeb) {
            frame = makeSimulatedFrame(simStepRef.current);
            simStepRef.current += 1;
          } else if (cameraRef.current && cameraReady) {
            frame = await probeCameraFrame(cameraRef.current);
            if (frame === null) {
              probeMissRef.current += 1;
              if (probeMissRef.current >= 2) {
                setProbesAvailable(current => (current === true ? current : false));
              }
            }
          } else {
            // Camera still warming up — not a probe failure yet; the
            // stall timeout below decides if it never comes.
            return;
          }
          if (disposed || !frame) return;
          probeMissRef.current = 0;
          setProbesAvailable(true);
          readingRef.current = detectorRef.current.push(frame);
        } finally {
          probeBusyRef.current = false;
        }
      })();
    }, getGuidedProbeIntervalMs());
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [stage.kind, isWeb, cameraReady]);

  // If probing never produces a verdict (camera never ready, manipulator
  // missing), declare it unavailable rather than waiting forever.
  useEffect(() => {
    if (stage.kind !== 'positioning' || probesAvailable !== null || isWeb) return;
    const timer = setTimeout(() => {
      setProbesAvailable(current => (current === null ? false : current));
    }, 6 * getGuidedProbeIntervalMs());
    return () => clearTimeout(timer);
  }, [stage, probesAvailable, isWeb]);

  // Same determination for tilt: a sensor that never delivers a sample is
  // declared unavailable — announced and gated around, never guessed.
  useEffect(() => {
    if (stage.kind !== 'positioning' || tiltAvailable !== null || isWeb) return;
    const timer = setTimeout(() => {
      setTiltAvailable(current => (current === null ? false : current));
    }, 6 * getGuidedProbeIntervalMs());
    return () => clearTimeout(timer);
  }, [stage, tiltAvailable, isWeb]);

  // ── The steady gate ───────────────────────────────────────────────────
  // Tilt + framing + light collapse into one status at a fast tick; all
  // green for the hold window auto-starts the countdown, and losing the
  // lock resets the bank with a falling cue.
  useEffect(() => {
    if (stage.kind !== 'positioning') return;
    const angle = stage.angle;
    const timer = setInterval(() => {
      const status = lineupStatus({
        leanDeg: leanDegRef.current,
        tiltAvailable,
        reading: readingRef.current,
        probesAvailable,
      });
      const verdict = holdRef.current.update(status === 'ready', Date.now(), getGuidedHoldMs());
      if (verdict.broke) {
        playHoldLost();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      }
      setLineup(current =>
        current.status === status &&
        current.leanDeg === leanDegRef.current &&
        Math.abs(current.holdProgress - verdict.progress) < 0.005
          ? current
          : { status, holdProgress: verdict.progress, leanDeg: leanDegRef.current },
      );
      if (verdict.satisfied) beginCountdown(angle);
    }, getGuidedGateTickMs());
    return () => clearInterval(timer);
  }, [stage, probesAvailable, tiltAvailable, beginCountdown, playHoldLost]);

  // The escape hatch: prolonged failure to satisfy the gate surfaces a
  // plain "Start anyway" so nobody gets stranded.
  useEffect(() => {
    if (stage.kind !== 'positioning') return;
    setShowEscape(false);
    const timer = setTimeout(() => {
      setShowEscape(true);
      const message = 'Taking a while to line up — you can start the countdown anyway when you are set.';
      announce(message);
      speakCue(message, screenReaderOnRef.current);
    }, getGuidedEscapeMs());
    return () => clearTimeout(timer);
  }, [stage]);

  // Probe-unavailable: with a tilt signal the gate honestly checks the
  // angle alone; with nothing to gate on at all, the hands-free promise
  // still holds — the countdown starts itself on a plain timer.
  useEffect(() => {
    if (stage.kind !== 'positioning' || probesAvailable !== false) return;
    if (!fallbackAnnouncedRef.current) {
      fallbackAnnouncedRef.current = true;
      if (tiltAvailable === true) {
        const message =
          'Automatic position check unavailable. The countdown starts once the phone angle holds steady.';
        announce(message);
        speakCue(message, screenReaderOnRef.current);
      } else {
        announce('Automatic position check unavailable. Get set — the countdown starts on its own in a few seconds.');
      }
    }
    if (tiltAvailable === true) return;
    const timer = setTimeout(
      () => beginCountdown(stage.angle),
      4 * getGuidedProbeIntervalMs(),
    );
    return () => clearTimeout(timer);
  }, [stage, probesAvailable, tiltAvailable, beginCountdown]);

  // Coach only when the status CHANGES — every tick would drown the room.
  // The first verdict stays silent when it merely repeats the angle intro
  // ("step back and stand in the outline"); a probe-unavailable "ready" is
  // a tilt-only verdict, so no "In position" claim either.
  useEffect(() => {
    if (stage.kind !== 'positioning' || !lineup.status) return;
    if (lastStatusRef.current === lineup.status) return;
    const first = lastStatusRef.current === null;
    lastStatusRef.current = lineup.status;
    if (first && lineup.status === 'not-detected') return;
    if (lineup.status === 'ready' && probesAvailable === false) return;
    // Probes-gone runs tell their own fallback story; a tilt-unavailable
    // status on top would contradict the timed-start message.
    if (lineup.status === 'tilt-unavailable' && probesAvailable === false) return;
    const message = LINEUP_ANNOUNCEMENTS[lineup.status];
    announce(message);
    speakCue(message, screenReaderOnRef.current);
  }, [stage, lineup.status, probesAvailable]);

  // ── Capture ───────────────────────────────────────────────────────────

  const advanceAfterCapture = useCallback((captured: GuidedAngle) => {
    queueRef.current = queueRef.current.filter(item => item !== captured);
    const next = queueRef.current[0];
    if (!next) {
      setStage({ kind: 'review' });
      const done = 'All photos captured. Review your shots.';
      announce(done);
      speakCue(done, screenReaderOnRef.current);
      return;
    }
    detectorRef.current.resetHold();
    holdRef.current.reset();
    lastStatusRef.current = null;
    readingRef.current = null;
    setLineup({ status: null, holdProgress: 0, leanDeg: leanDegRef.current });
    setStage({ kind: 'positioning', angle: next });
    const message = `Now the ${GUIDED_ANGLE_LABELS[next].toLowerCase()} photo. Turn, then hold still in the outline.`;
    announce(message);
    speakCue(message, screenReaderOnRef.current);
  }, []);

  const captureAngle = useCallback(
    async (angle: GuidedAngle) => {
      playTone();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      let shot: GuidedShot | null = null;
      if (isWeb) {
        // Live capture is native-only: the demo hands back the bundled
        // posing illustration so review + upload run the real pipeline.
        try {
          const asset = Asset.fromModule(GUIDED_POSE_IMAGES[angle] as number);
          await asset.downloadAsync().catch(() => {});
          const uri = asset.localUri ?? asset.uri;
          shot = { angle, uri, width: asset.width ?? 1024, height: asset.height ?? 1024 };
        } catch {
          shot = null;
        }
      } else {
        try {
          const camera = cameraRef.current;
          const photo = camera ? await camera.takePictureAsync({ quality: 1 }) : null;
          if (photo?.uri) {
            shot = { angle, uri: photo.uri, width: photo.width ?? 0, height: photo.height ?? 0 };
          }
        } catch (error) {
          console.error('Guided capture failed', error);
        }
      }
      if (!shot) {
        setCaptureError('That shot did not go through. Get back into position and it will retry.');
        detectorRef.current.resetHold();
        holdRef.current.reset();
        lastStatusRef.current = null;
        readingRef.current = null;
        setLineup({ status: null, holdProgress: 0, leanDeg: leanDegRef.current });
        setStage({ kind: 'positioning', angle });
        return;
      }
      // A reshot angle invalidates any earlier upload of that angle.
      uploadedRef.current.delete(angle);
      setShots(prev => ({ ...prev, [angle]: shot }));
      announce(`${GUIDED_ANGLE_LABELS[angle]} photo captured.`);
      advanceAfterCapture(angle);
    },
    [advanceAfterCapture, isWeb, playTone],
  );

  // ── Countdown ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (stage.kind !== 'countdown') return;
    if (stage.secondsLeft <= 0) {
      if (captureBusyRef.current) return;
      captureBusyRef.current = true;
      void captureAngle(stage.angle).finally(() => {
        captureBusyRef.current = false;
      });
      return;
    }
    playTick();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    announce(String(stage.secondsLeft));
    const timer = setTimeout(() => {
      setStage(current =>
        current.kind === 'countdown'
          ? { ...current, secondsLeft: current.secondsLeft - 1 }
          : current,
      );
    }, getGuidedTickIntervalMs());
    return () => clearTimeout(timer);
  }, [stage, captureAngle, playTick]);

  // ── Review / save ─────────────────────────────────────────────────────

  const toggleReshoot = (angle: GuidedAngle) => {
    void Haptics.selectionAsync().catch(() => {});
    const next = new Set(reshootSelection);
    if (next.has(angle)) next.delete(angle);
    else next.add(angle);
    setReshootSelection(next);
    announce(
      `${GUIDED_ANGLE_LABELS[angle]} ${next.has(angle) ? 'selected' : 'unselected'} for reshoot. ${next.size} selected.`,
    );
  };

  const beginReshoot = () => {
    const selected = GUIDED_ANGLES.filter(angle => reshootSelection.has(angle));
    if (selected.length === 0) return;
    void Haptics.selectionAsync().catch(() => {});
    setReshootSelection(new Set());
    setUploadError(null);
    startRun(selected);
  };

  const save = async () => {
    const all = GUIDED_ANGLES.map(angle => shots[angle]).filter(Boolean) as GuidedShot[];
    if (all.length === 0) return;
    setUploadError(null);
    setStage({ kind: 'saving' });
    announce('Saving your photos.');
    // Compression happens silently inside the upload pipeline; angles that
    // already landed on a previous attempt are not re-sent.
    const toUpload = all.filter(shot => !uploadedRef.current.has(shot.angle));
    const result = await uploadGuidedShots(toUpload);
    for (const ref of result.uploaded) uploadedRef.current.set(ref.angle, ref.objectPath);
    if (result.failed.length > 0) {
      const labels = result.failed.map(angle => GUIDED_ANGLE_LABELS[angle]).join(', ');
      setUploadError(
        `${labels} ${result.failed.length === 1 ? 'photo' : 'photos'} could not be uploaded. Your shots are still here — try Save again.`,
      );
      setStage({ kind: 'review' });
      return;
    }
    const week = Math.ceil(ENROLLMENT_DAYS / 7);
    const entries = GUIDED_ANGLES.filter(
      angle => shots[angle] && uploadedRef.current.has(angle),
    ).map(angle => ({
      dateKey: TODAY_KEY,
      label: `Week ${week} ${GUIDED_ANGLE_LABELS[angle]}`,
      angle,
      objectPath: uploadedRef.current.get(angle)!,
    }));
    try {
      await patient.addPhotos(entries);
    } catch {
      setUploadError('The photos uploaded but could not be added to your grid. Try Save again.');
      setStage({ kind: 'review' });
      return;
    }
    announce(`${entries.length} progress photos saved.`);
    finish({ savedCount: entries.length });
  };

  const close = () => {
    void Haptics.selectionAsync().catch(() => {});
    finish(null);
  };

  const topPad = Math.max(insets.top, 14);
  const bottomPad = Math.max(insets.bottom, 18);

  const activeAngle =
    stage.kind === 'positioning' || stage.kind === 'countdown' ? stage.angle : null;

  // ── Permission fallback (same in-surface style as the meal camera) ────
  if (fallbackMode) {
    return (
      <View
        testID="guided-session"
        style={[styles.root, { backgroundColor: colors.background, paddingTop: topPad, paddingBottom: bottomPad }]}
      >
        <View style={styles.fallbackWrap} testID="guided-fallback">
          <View style={[styles.fallbackIcon, { backgroundColor: colors.sidebarBg, borderColor: colors.border }]}>
            <Feather name="camera-off" size={26} color={colors.navyLight} />
          </View>
          <Text style={[styles.fallbackTitle, { color: colors.navy }]}>
            {mountError ? 'The camera could not start' : 'Camera access is off'}
          </Text>
          <Text style={[styles.fallbackBody, { color: colors.bodyText }]}>
            {mountError
              ? 'Close the session and try again in a moment.'
              : 'The guided session uses the front camera to take your progress photos. Allow camera access to continue.'}
          </Text>
          {!mountError && permission?.canAskAgain ? (
            <Pressable
              testID="guided-fallback-ask"
              accessibilityRole="button"
              onPress={() => void requestPermission()}
              style={({ pressed }) => [
                styles.fallbackBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.fallbackBtnText, { color: colors.primaryForeground }]}>Allow camera access</Text>
            </Pressable>
          ) : null}
          {!mountError && permission && !permission.canAskAgain ? (
            <Pressable
              testID="guided-fallback-settings"
              accessibilityRole="button"
              onPress={() => void Linking.openSettings()}
              style={({ pressed }) => [
                styles.fallbackBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.fallbackBtnText, { color: colors.primaryForeground }]}>Open Settings</Text>
            </Pressable>
          ) : null}
          <Pressable
            testID="guided-fallback-close"
            accessibilityRole="button"
            onPress={close}
            style={({ pressed }) => [styles.fallbackSecondary, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.fallbackSecondaryText, { color: colors.navyLight }]}>Not now</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View testID="guided-session" style={styles.root}>
      {/* Live preview (native) or simulated feed (web) behind everything. */}
      {cameraMode ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="front"
          animateShutter={false}
          onCameraReady={() => setCameraReady(true)}
          onMountError={() => setMountError(true)}
        />
      ) : null}
      {isWeb && stage.kind !== 'review' && stage.kind !== 'saving' ? (
        <DemoFeed angle={activeAngle} />
      ) : null}

      {/* ── Setup ── */}
      {stage.kind === 'setup' ? (
        <View style={[styles.sheet, { backgroundColor: colors.background, paddingTop: topPad }]}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: colors.navy }]}>Guided Photo Session</Text>
            <Pressable
              testID="guided-close"
              accessibilityRole="button"
              accessibilityLabel="Close the guided photo session"
              onPress={close}
              hitSlop={10}
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
              <Feather name="x" size={22} color={colors.navy} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.sheetBody, { paddingBottom: bottomPad + 12 }]}>
            <View style={[styles.stepCard, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
              {[
                { icon: 'smartphone' as const, text: 'Prop your phone on the floor against a wall, screen facing you, leaning slightly back — the big level bar on the next screen turns green at the right lean.' },
                { icon: 'user' as const, text: 'Use the front camera and step back about 6 feet so your whole body is in view.' },
                { icon: 'clock' as const, text: 'Once your angle and position hold steady, the app counts down from 7 and takes Front, Side, and Back shots by itself.' },
              ].map((step, index) => (
                <View key={step.icon} style={[styles.stepRow, index > 0 && { marginTop: 12 }]}>
                  <View style={[styles.stepIcon, { backgroundColor: colors.sidebarBg, borderColor: colors.border }]}>
                    <Feather name={step.icon} size={15} color={colors.cobalt} />
                  </View>
                  <Text style={[styles.stepText, { color: colors.bodyText }]}>{step.text}</Text>
                </View>
              ))}
            </View>

            {/* Posing examples */}
            <Text style={[styles.posesLabel, { color: colors.labelText }]}>THE THREE SHOTS</Text>
            <View style={styles.posesRow}>
              {GUIDED_ANGLES.map(angle => (
                <View
                  key={angle}
                  style={[styles.poseCard, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radiusSm }]}
                >
                  <Image
                    source={GUIDED_POSE_IMAGES[angle]}
                    style={styles.poseImage}
                    contentFit="cover"
                    transition={120}
                    accessibilityLabel={`${GUIDED_ANGLE_LABELS[angle]} pose example`}
                  />
                  <Text style={[styles.poseName, { color: colors.navyLight }]}>{GUIDED_ANGLE_LABELS[angle]}</Text>
                </View>
              ))}
            </View>

            {/* Hide instructions */}
            <Pressable
              testID="guided-hide-instructions"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: hidePref === true }}
              aria-checked={hidePref === true}
              accessibilityLabel="Hide these instructions next time"
              onPress={() => {
                const next = hidePref !== true;
                setHidePref(next);
                void writeHideInstructions(next);
                void Haptics.selectionAsync().catch(() => {});
              }}
              style={({ pressed }) => [styles.hideRow, pressed && { opacity: 0.7 }]}
            >
              <View
                style={[
                  styles.checkbox,
                  { borderColor: hidePref === true ? colors.cobalt : colors.border, backgroundColor: hidePref === true ? colors.cobalt : colors.paperCard },
                ]}
              >
                {hidePref === true ? <Feather name="check" size={13} color={colors.primaryForeground} /> : null}
              </View>
              <Text style={[styles.hideText, { color: colors.bodyText }]}>Hide these instructions next time</Text>
            </Pressable>

            {/* Start */}
            <Pressable
              testID="guided-begin"
              accessibilityRole="button"
              disabled={!isWeb && !cameraGranted}
              onPress={() => {
                void Haptics.selectionAsync().catch(() => {});
                startRun(GUIDED_ANGLES);
              }}
              style={({ pressed }) => [
                styles.startBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                (!isWeb && !cameraGranted) && { opacity: 0.5 },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.startBtnText, { color: colors.primaryForeground }]}>Start</Text>
            </Pressable>
            {!isWeb && !cameraGranted ? (
              <Text style={[styles.waitingNote, { color: colors.subtleText }]}>Waiting for camera permission…</Text>
            ) : null}
          </ScrollView>
        </View>
      ) : null}

      {/* ── Positioning (the line-up stage) ── */}
      {stage.kind === 'positioning' ? (
        <>
          <BodyOutline angle={stage.angle} ready={lineup.status === 'ready'} />
          <TiltLevelBar
            leanAnim={leanAnimRef.current}
            leanDeg={lineup.leanDeg}
            holdProgress={lineup.holdProgress}
            holdActive={lineup.status === 'ready'}
          />
          <View style={[styles.captureTop, { paddingTop: topPad }]} pointerEvents="box-none">
            <View style={styles.bannerBand} accessible accessibilityLabel={`${GUIDED_ANGLE_LABELS[stage.angle]} photo`}>
              <Text testID="guided-angle-banner" style={styles.bannerText}>
                {GUIDED_ANGLE_LABELS[stage.angle].toUpperCase()}
              </Text>
            </View>
            <Pressable
              testID="guided-close"
              accessibilityRole="button"
              accessibilityLabel="Close the guided photo session"
              onPress={close}
              hitSlop={10}
              style={({ pressed }) => [styles.closeFloat, pressed && { opacity: 0.7 }]}
            >
              <Feather name="x" size={20} color="#FFFFFF" />
            </Pressable>
          </View>
          <View style={[styles.captureBottom, { paddingBottom: bottomPad + 8 }]} pointerEvents="box-none">
            {captureError ? <ErrorNote text={captureError} testID="guided-capture-error" /> : null}
            <View style={styles.hintBand}>
              <Text testID="guided-positioning-hint" style={styles.hintText}>
                {probesAvailable === false && tiltAvailable !== true
                  ? 'Get set — starting shortly'
                  : lineup.status
                    ? LINEUP_HINTS[lineup.status]
                    : 'Step back about 6 feet'}
              </Text>
            </View>
            {showEscape ? (
              <Pressable
                testID="guided-start-anyway"
                accessibilityRole="button"
                accessibilityLabel="Start the countdown anyway"
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => {});
                  beginCountdown(stage.angle);
                }}
                style={({ pressed }) => [styles.escapeBtn, pressed && { opacity: 0.8 }]}
              >
                <Text style={styles.escapeText}>Start anyway</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}

      {/* ── Countdown ── */}
      {stage.kind === 'countdown' ? (
        <>
          <BodyOutline angle={stage.angle} ready dim />
          <View style={[styles.captureTop, { paddingTop: topPad }]} pointerEvents="box-none">
            <View style={styles.bannerBand} accessible accessibilityLabel={`${GUIDED_ANGLE_LABELS[stage.angle]} photo countdown`}>
              <Text testID="guided-angle-banner" style={styles.bannerText}>
                {GUIDED_ANGLE_LABELS[stage.angle].toUpperCase()}
              </Text>
            </View>
          </View>
          <View style={styles.countdownWrap} pointerEvents="none">
            <View style={[styles.posePreview, { borderColor: 'rgba(255,255,255,0.4)' }]}>
              <Image
                source={GUIDED_POSE_IMAGES[stage.angle]}
                style={styles.posePreviewImage}
                contentFit="cover"
                accessibilityLabel={`${GUIDED_ANGLE_LABELS[stage.angle]} pose example`}
              />
              <Text style={styles.posePreviewLabel}>Match this pose</Text>
            </View>
            <Text testID="guided-countdown" style={styles.countdownNumber}>
              {stage.secondsLeft > 0 ? stage.secondsLeft : ''}
            </Text>
          </View>
        </>
      ) : null}

      {/* ── Review ── */}
      {stage.kind === 'review' ? (
        <View style={[styles.sheet, { backgroundColor: colors.background, paddingTop: topPad }]}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: colors.navy }]}>Review Your Shots</Text>
            <Pressable
              testID="guided-close"
              accessibilityRole="button"
              accessibilityLabel="Close without saving"
              onPress={close}
              hitSlop={10}
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
              <Feather name="x" size={22} color={colors.navy} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.sheetBody, { paddingBottom: bottomPad + 12 }]}>
            <Text style={[styles.reviewNote, { color: colors.subtleText }]}>
              Check any shot you want to retake — the others are kept.
            </Text>
            {GUIDED_ANGLES.map(angle => {
              const shot = shots[angle];
              const selected = reshootSelection.has(angle);
              return (
                <View
                  key={angle}
                  style={[styles.reviewCard, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radiusSm }]}
                >
                  {shot ? (
                    <Image source={{ uri: shot.uri }} style={styles.reviewImage} contentFit="cover" transition={120} />
                  ) : (
                    <View style={[styles.reviewImage, { backgroundColor: colors.sidebarBg, alignItems: 'center', justifyContent: 'center' }]}>
                      <Feather name="image" size={20} color={colors.subtleText} />
                    </View>
                  )}
                  <View style={styles.reviewMeta}>
                    <Text style={[styles.reviewAngle, { color: colors.navy }]}>{GUIDED_ANGLE_LABELS[angle]}</Text>
                    <Text style={[styles.reviewSub, { color: colors.subtleText }]}>
                      {selected ? 'Will be reshot' : 'Looks good'}
                    </Text>
                  </View>
                  <Pressable
                    testID={`guided-reshoot-${angle}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    aria-checked={selected}
                    accessibilityLabel={`Reshoot the ${GUIDED_ANGLE_LABELS[angle].toLowerCase()} photo`}
                    onPress={() => toggleReshoot(angle)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.reshootToggle, pressed && { opacity: 0.7 }]}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        { borderColor: selected ? colors.cobalt : colors.border, backgroundColor: selected ? colors.cobalt : colors.paperCard },
                      ]}
                    >
                      {selected ? <Feather name="check" size={13} color={colors.primaryForeground} /> : null}
                    </View>
                    <Text style={[styles.reshootLabel, { color: selected ? colors.cobalt : colors.navyLight }]}>Reshoot</Text>
                  </Pressable>
                </View>
              );
            })}

            {uploadError ? <ErrorNote text={uploadError} testID="guided-upload-error" /> : null}

            {reshootSelection.size > 0 ? (
              <Pressable
                testID="guided-review-reshoot"
                accessibilityRole="button"
                onPress={beginReshoot}
                style={({ pressed }) => [
                  styles.reshootBtn,
                  { borderColor: colors.cobalt, borderRadius: colors.radiusSm },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Feather name="refresh-cw" size={15} color={colors.cobalt} />
                <Text style={[styles.reshootBtnText, { color: colors.cobalt }]}>
                  Reshoot selected ({reshootSelection.size})
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              testID="guided-review-save"
              accessibilityRole="button"
              onPress={() => void save()}
              style={({ pressed }) => [
                styles.startBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.startBtnText, { color: colors.primaryForeground }]}>
                {uploadError ? 'Try again' : 'Save to my progress'}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}

      {/* ── Saving ── */}
      {stage.kind === 'saving' ? (
        <View style={[styles.sheet, styles.savingWrap, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.cobalt} />
          <Text style={[styles.savingText, { color: colors.bodyText }]}>Saving your photos…</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#10161F',
  },
  sheet: {
    ...StyleSheet.absoluteFillObject,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sheetTitle: {
    fontFamily: 'PlayfairDisplay_600SemiBold',
    fontSize: 21,
  },
  sheetBody: {
    paddingHorizontal: 18,
  },
  stepCard: {
    borderWidth: 1,
    padding: 14,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  stepIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  posesLabel: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.2,
    marginTop: 16,
    marginBottom: 8,
  },
  posesRow: {
    flexDirection: 'row',
    gap: 10,
  },
  poseCard: {
    flex: 1,
    borderWidth: 1,
    padding: 6,
    alignItems: 'center',
  },
  poseImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 6,
  },
  poseName: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    marginTop: 6,
  },
  hideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hideText: {
    fontSize: 14,
  },
  startBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  startBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  waitingNote: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
  captureTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  bannerBand: {
    backgroundColor: BAND_SCRIM,
    paddingVertical: 10,
    alignItems: 'center',
  },
  bannerText: {
    color: '#FFFFFF',
    fontSize: 56,
    lineHeight: 62,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 10,
  },
  closeFloat: {
    position: 'absolute',
    left: 14,
    top: 0,
    marginTop: 8,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: CONTROL_SCRIM,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  hintBand: {
    backgroundColor: BAND_SCRIM,
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginBottom: 12,
    maxWidth: '100%',
  },
  hintText: {
    color: '#FFFFFF',
    fontSize: 24,
    lineHeight: 30,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  escapeBtn: {
    backgroundColor: CONTROL_SCRIM,
    borderColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1.5,
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  escapeText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  countdownWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownNumber: {
    color: '#FFFFFF',
    fontSize: 148,
    lineHeight: 160,
    fontFamily: 'Inter_700Bold',
    // RN-web wants the CSS shorthand; native takes the classic trio.
    ...(Platform.OS === 'web'
      ? ({ textShadow: '0 2px 24px rgba(0, 0, 0, 0.55)' } as object)
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.55)',
          textShadowOffset: { width: 0, height: 2 },
          textShadowRadius: 24,
        }),
  },
  posePreview: {
    position: 'absolute',
    top: '14%',
    right: 16,
    width: 92,
    borderWidth: 1.5,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: BAND_SCRIM,
  },
  posePreviewImage: {
    width: '100%',
    aspectRatio: 1,
  },
  posePreviewLabel: {
    color: '#FFFFFF',
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    paddingVertical: 4,
  },
  demoGhost: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.32,
  },
  demoBadge: {
    position: 'absolute',
    left: 10,
    bottom: '31%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: CONTROL_SCRIM,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  demoBadgeText: {
    color: '#DDE5EF',
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.4,
  },
  reviewNote: {
    fontSize: 13,
    marginBottom: 12,
  },
  reviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    padding: 10,
    marginBottom: 10,
    gap: 12,
  },
  reviewImage: {
    width: 72,
    height: 90,
    borderRadius: 6,
  },
  reviewMeta: {
    flex: 1,
  },
  reviewAngle: {
    fontFamily: 'PlayfairDisplay_600SemiBold',
    fontSize: 17,
  },
  reviewSub: {
    fontSize: 12,
    marginTop: 3,
  },
  reshootToggle: {
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 4,
  },
  reshootLabel: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
  },
  reshootBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1.5,
    paddingVertical: 12,
    marginTop: 4,
  },
  reshootBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  errorNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    alignSelf: 'stretch',
  },
  errorNoteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter_600SemiBold',
  },
  savingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  savingText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  fallbackWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  fallbackIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  fallbackTitle: {
    fontFamily: 'PlayfairDisplay_600SemiBold',
    fontSize: 20,
    textAlign: 'center',
    marginBottom: 8,
  },
  fallbackBody: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 20,
  },
  fallbackBtn: {
    alignSelf: 'stretch',
    paddingVertical: 13,
    alignItems: 'center',
  },
  fallbackBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  fallbackSecondary: {
    marginTop: 14,
    padding: 6,
  },
  fallbackSecondaryText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});
