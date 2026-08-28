/**
 * Guided hands-free progress-photo session.
 *
 * The patient props the phone on the floor (front camera facing them),
 * steps back about six feet, and the app walks them through three photos —
 * front, side, back — each with a spoken prompt, an audible 7-second
 * countdown, and an automatic shutter. Everything on screen is sized to be
 * legible from six feet away.
 *
 * After the third shot the review step runs the NO-AI quality checks
 * (lib/photo-analysis.ts): per-shot brightness plus cross-shot differencing
 * for "nobody in frame / too close / too far". Flagged angles come
 * pre-ticked for a retake; the patient can retake any subset, then save.
 * Saving compresses quietly, uploads to App Storage through the presigned
 * flow (lib/progress-upload.ts), and lands all three in the Progress grid
 * in one commit. A failed save keeps every shot on this screen and retries
 * skip angles that already uploaded.
 *
 * On web there is no camera worth trusting inside the preview iframe, so
 * the surface runs a clearly-labeled SIMULATED camera (lib/sim-camera.ts)
 * whose synthetic frames flow through the REAL analysis + upload pipeline —
 * the demo exercises everything but the shutter.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
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
import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';
import { ENROLLMENT_DAYS, TODAY_KEY } from '@/data/patient-data';
import {
  ANGLE_META,
  DEFAULT_TIMING,
  SESSION_ANGLES,
  activeAngle,
  buildPhotoLabel,
  reshootQueue,
  sessionReducer,
  type SessionAngle,
  type SessionShot,
  type SessionTimingConfig,
} from '@/lib/progress-session';
import {
  analyzeSession,
  decodeJpegBase64ToGray,
  type GrayFrame,
  type SessionAnalysis,
} from '@/lib/photo-analysis';
import {
  SIM_FRAME_HEIGHT,
  SIM_FRAME_WIDTH,
  buildSimulatedGrayFrame,
  buildSimulatedShotDataUri,
} from '@/lib/sim-camera';
import { createSessionFeedback, type SessionFeedback } from '@/lib/session-feedback';
import { TILT_MESSAGES, useDeviceTilt } from '@/lib/tilt';
import {
  ProgressUploadError,
  uploadProgressShots,
  type ShotToUpload,
} from '@/lib/progress-upload';
import { BodyOutline } from '@/components/patient/BodyOutline';
import { POSE_IMAGES } from '@/components/patient/pose-images';

/** Scrim behind text floating over the live preview. */
const SCRIM = 'rgba(16, 22, 31, 0.42)';
const PREVIEW_BG = '#151C26';

function prettyAngle(angle: SessionAngle): string {
  const title = ANGLE_META[angle].title;
  return title.charAt(0) + title.slice(1).toLowerCase();
}

interface GuidedSessionSurfaceProps {
  /** Called when the patient closes the surface or the save completes. */
  onDone: () => void;
  /** Test override: run the countdown faster than the shipped cadence. */
  timing?: SessionTimingConfig;
}

export function GuidedSessionSurface({ onDone, timing = DEFAULT_TIMING }: GuidedSessionSurfaceProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const simMode = Platform.OS === 'web';

  const [phase, dispatch] = useReducer(sessionReducer, { kind: 'setup' as const });
  const [shots, setShots] = useState<Partial<Record<SessionAngle, SessionShot>>>({});
  const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null);
  const [reshootSel, setReshootSel] = useState<Partial<Record<SessionAngle, boolean>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mountError, setMountError] = useState(false);
  const [instructionsOverride, setInstructionsOverride] = useState<boolean | null>(null);
  const [previewH, setPreviewH] = useState(0);

  const grayRef = useRef<Partial<Record<SessionAngle, GrayFrame>>>({});
  const uploadedRef = useRef<Partial<Record<SessionAngle, string>>>({});
  const cameraRef = useRef<CameraView | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);

  const feedbackRef = useRef<SessionFeedback | null>(null);
  if (!feedbackRef.current) feedbackRef.current = createSessionFeedback();

  const [permission, requestPermission] = useCameraPermissions();
  const askedRef = useRef(false);
  const tilt = useDeviceTilt(phase.kind === 'setup' && !simMode);

  const close = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  useEffect(() => {
    const feedback = feedbackRef.current;
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      feedback?.dispose();
    };
  }, []);

  // Ask for the front camera once on arrival — only while undetermined, the
  // same respectful pattern as the food camera. Web never asks: sim mode.
  useEffect(() => {
    if (simMode || !permission || askedRef.current) return;
    if (permission.status !== 'undetermined') return;
    askedRef.current = true;
    void requestPermission();
  }, [simMode, permission, requestPermission]);

  // iOS has no live regions; announce save errors explicitly there.
  useEffect(() => {
    if (saveError && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(saveError);
    }
  }, [saveError]);

  // ── Countdown: one audible tick per second ───────────────────────────
  useEffect(() => {
    if (phase.kind !== 'countdown') return;
    const timer = setTimeout(() => {
      feedbackRef.current?.tick();
      dispatch({ type: 'TICK' });
    }, timing.tickMs);
    return () => clearTimeout(timer);
  }, [phase, timing.tickMs]);

  // Speak the pose at the top of each angle's countdown.
  useEffect(() => {
    if (phase.kind !== 'countdown') return;
    if (phase.secondsLeft !== Math.max(1, Math.round(timing.countdownSeconds))) return;
    const angle = phase.queue[phase.index];
    if (angle) feedbackRef.current?.speak(ANGLE_META[angle].spoken);
  }, [phase, timing.countdownSeconds]);

  // ── Auto-capture when the countdown hits zero ─────────────────────────
  useEffect(() => {
    if (phase.kind !== 'capturing') return;
    const angle = phase.queue[phase.index];
    if (!angle) return;
    let cancelled = false;

    const capture = async (): Promise<void> => {
      if (simMode) {
        // Let the "hold still" frame paint, then synthesize through the
        // REAL pipeline: gray frame for analysis, data URI for display.
        await new Promise(resolve => setTimeout(resolve, Math.min(200, timing.tickMs)));
        if (cancelled) return;
        grayRef.current[angle] = buildSimulatedGrayFrame(angle);
        const shot: SessionShot = {
          angle,
          uri: buildSimulatedShotDataUri(angle),
          width: SIM_FRAME_WIDTH,
          height: SIM_FRAME_HEIGHT,
        };
        setShots(prev => ({ ...prev, [angle]: shot }));
        return;
      }
      const camera = cameraRef.current;
      if (!camera) throw new Error('Camera is not ready');
      const photo = await camera.takePictureAsync({ quality: 0.85 });
      if (!photo?.uri) throw new Error('The camera returned no photo');
      if (cancelled) return;
      // Small grayscale frame for the no-AI checks; best-effort — a shot
      // that resists analysis is still a perfectly good photo.
      try {
        const rendered = await ImageManipulator.manipulate(photo.uri)
          .resize({ width: 192 })
          .renderAsync();
        const saved = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.6,
          base64: true,
        });
        if (!cancelled && saved.base64) {
          grayRef.current[angle] = decodeJpegBase64ToGray(saved.base64);
        }
      } catch {
        delete grayRef.current[angle];
      }
      if (cancelled) return;
      const shot: SessionShot = {
        angle,
        uri: photo.uri,
        width: photo.width ?? 0,
        height: photo.height ?? 0,
      };
      setShots(prev => ({ ...prev, [angle]: shot }));
    };

    (async () => {
      try {
        await capture();
        if (!cancelled) feedbackRef.current?.capture();
      } catch {
        // Keep whatever shot the angle had before (a failed RETAKE never
        // destroys the original); a first-run failure just stays missing
        // and gets flagged at review.
        if (!cancelled) feedbackRef.current?.alert();
      } finally {
        if (!cancelled) {
          dispatch({ type: 'SHOT_DONE', countdownSeconds: timing.countdownSeconds });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, simMode, timing.countdownSeconds, timing.tickMs]);

  // ── Entering review: run the no-AI checks over the current shots ──────
  const prevKindRef = useRef<string>('setup');
  useEffect(() => {
    if (phase.kind === 'review' && prevKindRef.current !== 'review') {
      const result = analyzeSession(SESSION_ANGLES, grayRef.current);
      setAnalysis(result);
      setReshootSel({ ...result.preselect });
      const flagged = SESSION_ANGLES.filter(a => result.preselect[a]).length;
      feedbackRef.current?.speak(
        flagged === 0
          ? 'All three photos look good. Review and save.'
          : 'Review your photos. Some may need a retake.',
      );
    }
    prevKindRef.current = phase.kind;
  }, [phase.kind]);

  const handleStart = () => {
    setSaveError(null);
    void feedbackRef.current?.ready();
    dispatch({
      type: 'BEGIN',
      queue: SESSION_ANGLES,
      countdownSeconds: timing.countdownSeconds,
    });
  };

  const handleRetakeSelected = () => {
    const queue = reshootQueue(reshootSel);
    if (queue.length === 0) return;
    setSaveError(null);
    setAnalysis(null);
    dispatch({ type: 'BEGIN', queue, countdownSeconds: timing.countdownSeconds });
  };

  const allPresent = SESSION_ANGLES.every(a => shots[a] !== undefined);
  const selectedCount = SESSION_ANGLES.filter(a => reshootSel[a] === true).length;

  const handleSave = async () => {
    if (!allPresent || phase.kind !== 'review') return;
    setSaveError(null);
    dispatch({ type: 'SAVE_START', total: SESSION_ANGLES.length });
    try {
      const toUpload: ShotToUpload[] = SESSION_ANGLES.map(a => ({
        angle: a,
        uri: shots[a]!.uri,
        width: shots[a]!.width,
      }));
      const paths = await uploadProgressShots(toUpload, uploadedRef.current, () =>
        dispatch({ type: 'SAVE_PROGRESS' }),
      );
      uploadedRef.current = paths;
      const week = Math.ceil(ENROLLMENT_DAYS / 7);
      await patient.addPhotoSession(
        SESSION_ANGLES.map(a => ({
          dateKey: TODAY_KEY,
          uri: shots[a]!.uri,
          label: buildPhotoLabel(week, a),
          angle: a,
          objectPath: paths[a],
        })),
      );
      dispatch({ type: 'SAVE_DONE' });
      feedbackRef.current?.speak('Photos saved.');
      savedTimerRef.current = setTimeout(close, 1400);
    } catch (error) {
      feedbackRef.current?.alert();
      const message =
        error instanceof ProgressUploadError
          ? `${error.message} (${prettyAngle(error.angle)} photo.) Your photos are still here — check your connection and tap Save again.`
          : 'Saving failed. Your photos are still here — check your connection and tap Save again.';
      setSaveError(message);
      dispatch({ type: 'SAVE_FAILED' });
    }
  };

  const cameraGranted = permission?.granted === true;
  const nativeBlocked = !simMode && (permission?.status === 'denied' || (cameraGranted && mountError));
  const currentAngle = activeAngle(phase);
  const inCapture = phase.kind === 'countdown' || phase.kind === 'capturing';

  // ── Fallback: camera denied or failed to start (native only) ──────────
  if (nativeBlocked && phase.kind === 'setup') {
    const canAskAgain = permission?.canAskAgain !== false;
    return (
      <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <SurfaceHeader onClose={close} title="Guided Photo Session" />
        <View style={styles.fallbackWrap}>
          <Feather name="camera-off" size={40} color={colors.navyLight} />
          <Text style={[styles.fallbackTitle, { color: colors.navy }]}>
            {mountError ? 'The camera could not start' : 'Camera access is off'}
          </Text>
          <Text style={[styles.fallbackBody, { color: colors.labelText }]}>
            The guided session takes your three progress photos automatically, so it needs the
            camera. {mountError ? 'Close and reopen the app, then try again.' : canAskAgain ? 'Allow camera access to continue.' : 'Turn the camera on for this app in Settings.'}
          </Text>
          {!mountError && (
            <Pressable
              testID="guided-camera-permission"
              accessibilityRole="button"
              onPress={() => {
                if (canAskAgain) void requestPermission();
                else void Linking.openSettings();
              }}
              style={({ pressed }) => [
                styles.bigBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.bigBtnText, { color: colors.primaryForeground }]}>
                {canAskAgain ? 'Allow Camera Access' : 'Open Settings'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  // ── Countdown / capturing: full-bleed camera with overlay ─────────────
  if (inCapture && currentAngle) {
    const queue = phase.kind === 'countdown' || phase.kind === 'capturing' ? phase.queue : SESSION_ANGLES;
    const index = phase.kind === 'countdown' || phase.kind === 'capturing' ? phase.index : 0;
    return (
      <View style={[styles.root, { backgroundColor: PREVIEW_BG }]} testID="guided-capture-stage">
        {!simMode && cameraGranted && (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="front"
            animateShutter={false}
            onMountError={() => setMountError(true)}
          />
        )}
        {/* Step-into outline, sized to the visible preview */}
        <View
          style={styles.outlineWrap}
          pointerEvents="none"
          onLayout={event => setPreviewH(event.nativeEvent.layout.height)}
        >
          {previewH > 0 && <BodyOutline angle={currentAngle} height={previewH * 0.7} />}
        </View>

        <View style={[styles.captureTop, { paddingTop: insets.top + 10 }]}>
          <Text style={styles.angleKicker} testID="guided-photo-index">
            PHOTO {index + 1} OF {queue.length}
          </Text>
          <Text style={styles.angleTitle} testID="guided-angle-title">
            {ANGLE_META[currentAngle].title}
          </Text>
          <Text style={styles.angleGuidance}>{ANGLE_META[currentAngle].guidance}</Text>
        </View>

        <View style={[styles.captureBottom, { paddingBottom: insets.bottom + 26 }]}>
          {phase.kind === 'countdown' ? (
            <Text style={styles.countdownNumber} testID="guided-countdown-number">
              {phase.secondsLeft}
            </Text>
          ) : (
            <Text style={styles.holdStill} testID="guided-hold-still">
              HOLD STILL…
            </Text>
          )}
          {simMode && (
            <View style={styles.simChip} testID="guided-sim-note">
              <Feather name="monitor" size={13} color="#FFFFFF" />
              <Text style={styles.simChipText}>Simulated camera — web preview</Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  // ── Saving overlay ─────────────────────────────────────────────────────
  if (phase.kind === 'saving') {
    const current = Math.min(phase.done + 1, phase.total);
    return (
      <View style={[styles.root, styles.centerWrap, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.cobalt} />
        <Text style={[styles.savingTitle, { color: colors.navy }]} testID="guided-saving">
          Saving photo {current} of {phase.total}…
        </Text>
        <Text style={[styles.savingSub, { color: colors.labelText }]}>
          Uploading securely to your progress record.
        </Text>
      </View>
    );
  }

  // ── Saved confirmation ────────────────────────────────────────────────
  if (phase.kind === 'saved') {
    return (
      <View style={[styles.root, styles.centerWrap, { backgroundColor: colors.background }]}>
        <View style={[styles.savedBadge, { backgroundColor: colors.cobalt }]}>
          <Feather name="check" size={38} color={colors.primaryForeground} />
        </View>
        <Text style={[styles.savedTitle, { color: colors.navy }]} testID="guided-saved">
          Photos saved
        </Text>
        <Text style={[styles.savingSub, { color: colors.labelText }]}>
          All three are in your Progress gallery.
        </Text>
      </View>
    );
  }

  // ── Review ────────────────────────────────────────────────────────────
  if (phase.kind === 'review') {
    return (
      <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <SurfaceHeader onClose={close} title="How do these look?" />
        <ScrollView contentContainerStyle={[styles.reviewContent, { paddingBottom: insets.bottom + 24 }]}>
          {saveError && (
            <View
              testID="guided-error"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[styles.errorBox, { backgroundColor: colors.riskBg ?? '#FBEAE8', borderColor: colors.riskText }]}
            >
              <Feather name="alert-triangle" size={16} color={colors.riskText} />
              <Text style={[styles.errorText, { color: colors.riskText }]}>{saveError}</Text>
            </View>
          )}
          {SESSION_ANGLES.map(angle => {
            const shot = shots[angle];
            const reasons = analysis?.reasons[angle] ?? [];
            const selected = reshootSel[angle] === true;
            const clean = shot !== undefined && reasons.length === 0;
            return (
              <View
                key={angle}
                style={[styles.reviewCard, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radius }]}
              >
                {shot ? (
                  <Image source={{ uri: shot.uri }} style={styles.reviewThumb} contentFit="cover" transition={100} />
                ) : (
                  <View style={[styles.reviewThumb, styles.reviewThumbMissing, { backgroundColor: colors.background }]}>
                    <Feather name="camera-off" size={22} color={colors.navyLight} />
                  </View>
                )}
                <View style={styles.reviewInfo}>
                  <Text style={[styles.reviewAngle, { color: colors.navy }]}>{prettyAngle(angle)}</Text>
                  {clean ? (
                    <View style={styles.reviewStatusRow}>
                      <Feather name="check-circle" size={14} color={colors.cobalt} />
                      <Text style={[styles.reviewOk, { color: colors.cobalt }]}>Looks good</Text>
                    </View>
                  ) : (
                    reasons.map(reason => (
                      <View key={reason} style={styles.reviewStatusRow}>
                        <Feather name="alert-triangle" size={14} color={colors.warnText ?? '#8A6100'} />
                        <Text style={[styles.reviewReason, { color: colors.warnText ?? '#8A6100' }]}>{reason}</Text>
                      </View>
                    ))
                  )}
                  <Pressable
                    testID={`guided-retake-${angle}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    aria-checked={selected}
                    accessibilityLabel={`Retake the ${prettyAngle(angle)} photo`}
                    onPress={() => setReshootSel(prev => ({ ...prev, [angle]: !selected }))}
                    style={({ pressed }) => [styles.retakeToggle, pressed && { opacity: 0.8 }]}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        { borderColor: selected ? colors.cobalt : colors.border, backgroundColor: selected ? colors.cobalt : 'transparent' },
                      ]}
                    >
                      {selected && <Feather name="check" size={13} color={colors.primaryForeground} />}
                    </View>
                    <Text style={[styles.retakeLabel, { color: colors.navy }]}>Retake this photo</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}

          {selectedCount > 0 && (
            <Pressable
              testID="guided-retake-selected"
              accessibilityRole="button"
              onPress={handleRetakeSelected}
              style={({ pressed }) => [
                styles.bigBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.bigBtnText, { color: colors.primaryForeground }]}>
                Retake {selectedCount === 1 ? 'Selected Photo' : `${selectedCount} Photos`}
              </Text>
            </Pressable>
          )}
          <Pressable
            testID="guided-save"
            accessibilityRole="button"
            aria-disabled={!allPresent}
            onPress={() => {
              if (!allPresent) {
                setSaveError('One of the photos did not capture — retake it before saving.');
                return;
              }
              void handleSave();
            }}
            style={({ pressed }) => [
              styles.bigBtn,
              selectedCount > 0 || !allPresent
                ? { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.cobalt }
                : { backgroundColor: colors.cobalt },
              { borderRadius: colors.radiusSm, opacity: allPresent ? 1 : 0.55 },
              pressed && allPresent && { opacity: 0.88 },
            ]}
          >
            <Text
              style={[
                styles.bigBtnText,
                { color: selectedCount > 0 || !allPresent ? colors.cobalt : colors.primaryForeground },
              ]}
            >
              Save 3 Photos
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // ── Setup ─────────────────────────────────────────────────────────────
  const showInstructions = instructionsOverride ?? !patient.hideSessionInstructions;
  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <SurfaceHeader onClose={close} title="Guided Photo Session" />
      <ScrollView contentContainerStyle={[styles.setupContent, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={[styles.setupLede, { color: colors.labelText }]}>
          Three photos — front, side, and back — taken hands-free with a spoken countdown.
        </Text>

        {showInstructions ? (
          <View
            testID="guided-instructions"
            style={[styles.instructionCard, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radius }]}
          >
            {[
              'Prop your phone upright on the floor, leaning against a wall.',
              'Step back about six feet so your whole body is in view.',
              'Listen — each pose is announced, then the countdown ticks from 7.',
              'Step into the outline. The photo takes itself.',
            ].map((step, index) => (
              <View key={step} style={styles.stepRow}>
                <View style={[styles.stepNum, { backgroundColor: colors.cobalt }]}>
                  <Text style={[styles.stepNumText, { color: colors.primaryForeground }]}>{index + 1}</Text>
                </View>
                <Text style={[styles.stepText, { color: colors.navy }]}>{step}</Text>
              </View>
            ))}

            <View style={styles.poseRow}>
              {SESSION_ANGLES.map(angle => (
                <View key={angle} style={styles.poseCol}>
                  <Image
                    source={POSE_IMAGES[angle]}
                    style={[styles.poseImage, { borderRadius: colors.radiusSm }]}
                    contentFit="cover"
                    transition={120}
                  />
                  <Text style={[styles.poseLabel, { color: colors.labelText }]}>{ANGLE_META[angle].title}</Text>
                </View>
              ))}
            </View>

            <Pressable
              testID="guided-hide-instructions"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: patient.hideSessionInstructions }}
              aria-checked={patient.hideSessionInstructions}
              onPress={() => void patient.setHideSessionInstructions(!patient.hideSessionInstructions)}
              style={({ pressed }) => [styles.retakeToggle, { marginTop: 4 }, pressed && { opacity: 0.8 }]}
            >
              <View
                style={[
                  styles.checkbox,
                  {
                    borderColor: patient.hideSessionInstructions ? colors.cobalt : colors.border,
                    backgroundColor: patient.hideSessionInstructions ? colors.cobalt : 'transparent',
                  },
                ]}
              >
                {patient.hideSessionInstructions && (
                  <Feather name="check" size={13} color={colors.primaryForeground} />
                )}
              </View>
              <Text style={[styles.retakeLabel, { color: colors.navy }]}>Don't show these steps again</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            testID="guided-show-instructions"
            accessibilityRole="button"
            onPress={() => setInstructionsOverride(true)}
            style={({ pressed }) => [styles.showStepsLink, pressed && { opacity: 0.7 }]}
          >
            <Feather name="help-circle" size={15} color={colors.cobalt} />
            <Text style={[styles.showStepsText, { color: colors.cobalt }]}>Show me the steps</Text>
          </Pressable>
        )}

        {!simMode && tilt.zone !== 'unavailable' && (
          <View
            testID="guided-tilt-meter"
            style={[styles.tiltRow, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radiusSm }]}
          >
            <View
              style={[
                styles.tiltDot,
                { backgroundColor: tilt.zone === 'ready' ? '#2E7D32' : tilt.zone === 'almost' ? '#B98A00' : colors.navyLight },
              ]}
            />
            <Text style={[styles.tiltText, { color: colors.navy }]}>{TILT_MESSAGES[tilt.zone]}</Text>
          </View>
        )}

        {simMode && (
          <View style={[styles.tiltRow, { backgroundColor: colors.paperCard, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
            <Feather name="monitor" size={15} color={colors.navyLight} />
            <Text style={[styles.tiltText, { color: colors.labelText }]}>
              Web preview: the session runs with a simulated camera.
            </Text>
          </View>
        )}

        <Pressable
          testID="guided-start"
          accessibilityRole="button"
          onPress={handleStart}
          style={({ pressed }) => [
            styles.bigBtn,
            styles.startBtn,
            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
            pressed && { opacity: 0.88 },
          ]}
        >
          <Feather name="camera" size={19} color={colors.primaryForeground} />
          <Text style={[styles.bigBtnText, { color: colors.primaryForeground }]}>Start Session</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function SurfaceHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.header}>
      <Text style={[styles.headerTitle, { color: colors.navy }]}>{title}</Text>
      <Pressable
        testID="guided-close"
        accessibilityRole="button"
        accessibilityLabel="Close the photo session"
        hitSlop={10}
        onPress={onClose}
        style={({ pressed }) => [styles.headerClose, { borderColor: colors.border }, pressed && { opacity: 0.7 }]}
      >
        <Feather name="x" size={20} color={colors.navy} />
      </Pressable>
    </View>
  );
}

const NUMBER_SHADOW = Platform.select({
  web: { textShadow: '0 2px 14px rgba(0, 0, 0, 0.6)' } as const,
  default: {
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 14,
  } as const,
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  centerWrap: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  headerTitle: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 24 },
  headerClose: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Setup
  setupContent: { paddingHorizontal: 18, gap: 14 },
  setupLede: { fontFamily: 'Inter_400Regular', fontSize: 16, lineHeight: 23 },
  instructionCard: { borderWidth: 1, padding: 16, gap: 12 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  stepText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 16.5, lineHeight: 23 },
  poseRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  poseCol: { flex: 1, alignItems: 'center', gap: 5 },
  poseImage: { width: '100%', aspectRatio: 1, backgroundColor: '#EFEBE2' },
  poseLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 11.5, letterSpacing: 1.1 },
  showStepsLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  showStepsText: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  tiltRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  tiltDot: { width: 12, height: 12, borderRadius: 6 },
  tiltText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 15, lineHeight: 21 },
  bigBtn: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  startBtn: { flexDirection: 'row', gap: 10, marginTop: 4 },
  bigBtnText: { fontFamily: 'Inter_700Bold', fontSize: 18 },

  // Capture stage
  outlineWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 8,
  },
  captureTop: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 18,
    backgroundColor: SCRIM,
  },
  angleKicker: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
    letterSpacing: 2.2,
  },
  angleTitle: { color: '#FFFFFF', fontFamily: 'PlayfairDisplay_700Bold', fontSize: 58, lineHeight: 64 },
  angleGuidance: {
    color: 'rgba(255, 255, 255, 0.95)',
    fontFamily: 'Inter_500Medium',
    fontSize: 18,
    lineHeight: 25,
    textAlign: 'center',
  },
  captureBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: 10,
  },
  countdownNumber: {
    color: '#FFFFFF',
    fontFamily: 'Inter_700Bold',
    fontSize: 128,
    lineHeight: 136,
    ...NUMBER_SHADOW,
  },
  holdStill: {
    color: '#FFFFFF',
    fontFamily: 'Inter_700Bold',
    fontSize: 30,
    letterSpacing: 3,
    ...NUMBER_SHADOW,
  },
  simChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: SCRIM,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 15,
  },
  simChipText: { color: '#FFFFFF', fontFamily: 'Inter_500Medium', fontSize: 12.5 },

  // Review
  reviewContent: { paddingHorizontal: 18, gap: 12 },
  reviewCard: { flexDirection: 'row', borderWidth: 1, padding: 12, gap: 12 },
  reviewThumb: { width: 92, height: 122, borderRadius: 7 },
  reviewThumbMissing: { alignItems: 'center', justifyContent: 'center' },
  reviewInfo: { flex: 1, gap: 6, justifyContent: 'center' },
  reviewAngle: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 20 },
  reviewStatusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  reviewOk: { fontFamily: 'Inter_600SemiBold', fontSize: 14.5 },
  reviewReason: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14.5, lineHeight: 20 },
  retakeToggle: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retakeLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 15.5 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderRadius: 9,
    padding: 12,
  },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14.5, lineHeight: 20 },

  // Saving / saved
  savingTitle: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 24, textAlign: 'center' },
  savingSub: { fontFamily: 'Inter_400Regular', fontSize: 15, textAlign: 'center', lineHeight: 21 },
  savedBadge: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedTitle: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 28 },

  // Fallback
  fallbackWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 14 },
  fallbackTitle: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 24, textAlign: 'center' },
  fallbackBody: {
    fontFamily: 'Inter_400Regular',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
    maxWidth: 320,
  },
});
