/**
 * THINNR Coach — full-screen AI chat for patients.
 *
 * Heritage Hero styling: paper assistant bubbles and cobalt patient bubbles
 * on soft-radius geometry (9 cards / 7 controls), a serif screen title, Inter
 * body and uppercase micro-labels, orange reserved for small accents, no
 * emojis anywhere. The disclosure card is pinned as the first thread item
 * and a compact AI badge sits in the header, so the assistant is always
 * clearly labeled as AI.
 *
 * The thread opens with the session's seeded coach greeting (see
 * CoachChatContext); the starter prompts render beneath it until the patient
 * sends their first message.
 *
 * Photo turns: the camera button beside the input offers taking a photo or
 * choosing one. "Take a photo" opens the app's own full-screen camera
 * (app/food-camera: live preview with a corner library shortcut); the shot
 * or corner pick comes back here, is downscaled by the shared photo-prep
 * helper, and stages the app's single blue "Use this photo" confirmation
 * before anything sends. The "Choose from library" chip and the web picker
 * keep their immediate prepare-and-send path. Either way the turn renders
 * as a photo bubble and no kind is attached — the server looks at the
 * photo and routes it itself: menus come back as ordering suggestions with
 * the usual one-tap chips, plates as an editable meal card. The photo
 * stays in client state, so a failed turn retries in one tap.
 *
 * Meal photo turns arrive via the shared MealPhotoButton (Library/Diary
 * entry points) with kind "meal": the coach answers with what it sees on
 * the plate plus an editable meal card, and a "Retake photo" chip rides
 * under the newest finished meal reply so a bad guess is one tap from a
 * new shot.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { OrdinaryTextInput as TextInput } from "@/components/ui/OrdinaryTextInput";
import {
  KeyboardEvents,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CoachCardSlot } from "@/components/coach/CoachCardSlot";
import { ThinkingIndicator } from "@/components/coach/ThinkingIndicator";
import type { CoachStage } from "@/lib/coach-api";
// Side-effect imports: register the "product" and "recipe" card renderers
// into the card slot.
import "@/components/coach/ProductSuggestionCard";
import "@/components/coach/RecipeSuggestionCard";
import "@/components/coach/FoodDraftCard";
import { MealPhotoButton } from "@/components/patient/MealPhotoButton";
import { AppModal } from "@/components/ui/AppModal";
import { useColors } from "@/hooks/useColors";
import {
  offersMealPhotoRetake,
  useCoachChat,
  type CoachMessage,
} from "@/context/CoachChatContext";
import { isOutreachMessageId } from "@/data/stall-nudge";
import { createFoodCameraRequest, type FoodCameraCapture } from "@/lib/food-camera";
import { preparePhotoForUpload, type PreparedPhoto } from "@/lib/photo-prep";

/** Heritage soft shadows as boxShadow strings (shadow* props warn on web). */
const CARD_SHADOW = "0 8px 20px rgba(40, 55, 74, 0.07)";
const BUBBLE_SHADOW = "0 5px 12px rgba(35, 61, 95, 0.07)";
const CHIP_SHADOW = "0 5px 12px rgba(35, 61, 95, 0.08)";

const STARTER_PROMPTS = [
  "What should I eat today?",
  "Is grapefruit approved?",
  "Give me a dinner idea for tonight",
  "I'm craving something sweet",
  "What do I order at a restaurant?",
];

/**
 * Static pair used when the server sent no tailored suggestion — it fits the
 * default yes/no closing question the coach is prompted toward.
 */
const FALLBACK_QUICK_REPLIES = ["Yes, please", "No thanks"];

/**
 * Quick-reply chips show only under the newest assistant message, and only
 * when that reply finished cleanly (not streaming, not an error) and closes
 * with a question — the shape coach replies are prompted to end with. Tapping
 * a chip sends it as the patient's message, which appends to the thread and
 * therefore hides the chips automatically. Only actual replies qualify
 * (`replyToId` set): the seeded greeting invites conversation through the
 * starter prompts instead, so it never grows chips. The one exception is
 * the coach-initiated stall outreach — it replies to nothing but ends on
 * its offer question and carries its own answer labels, so it qualifies by
 * id.
 */
function offersQuickReplies(
  latest: CoachMessage | undefined,
  isStreaming: boolean,
): boolean {
  return (
    !isStreaming &&
    latest !== undefined &&
    latest.role === "assistant" &&
    latest.status === "done" &&
    (latest.replyToId !== undefined || isOutreachMessageId(latest.id)) &&
    latest.text.trimEnd().endsWith("?")
  );
}

/**
 * Chip labels for the newest reply: the server-curated suggestion when one
 * arrived (e.g. "Surprise me" / "Something light" under an open-ended
 * question), else the static yes/no pair.
 */
function quickRepliesFor(latest: CoachMessage | undefined): string[] {
  const suggested = latest?.quickReplies ?? [];
  return suggested.length > 0 ? suggested : FALLBACK_QUICK_REPLIES;
}
/** Clamp the staged preview tile to sane portrait/landscape bounds. */
const stagedAspect = (photo: PreparedPhoto) =>
  Math.min(Math.max(photo.width / Math.max(photo.height, 1), 0.62), 1.7);

export default function CoachChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { messages, isStreaming, send, sendPhoto, stop, coachPaused } =
    useCoachChat();
  const [draft, setDraft] = useState("");
  const [photoOptionsOpen, setPhotoOptionsOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // A camera capture (or the camera's corner library pick) staged for the
  // single blue confirmation below. The "Choose from library" chip and the
  // web picker send straight away instead, exactly as before.
  const [stagedPhoto, setStagedPhoto] = useState<PreparedPhoto | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Where the staged photo came from, so "Retake" reopens the same source
  // (the camera again, or straight back into the library).
  const stagedSourceRef = useRef<FoodCameraCapture["source"]>("camera");
  // Reveal ticks change `messages` ~30×/s while a reply types out; only pin
  // to the bottom while the patient is already reading there, so scrolling
  // up to re-read older answers never fights the typing animation.
  const nearBottomRef = useRef(true);
  const messageCountRef = useRef(0);

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top;
  // The seeded greeting means the thread is never empty; "fresh chat" is now
  // "no user message yet", which keeps the starter prompts on screen.
  const hasUserMessage = messages.some((m) => m.role === "user");

  useEffect(() => {
    // Follow the thread: always jump for a new bubble (sending scrolls you
    // home), but during a paced reveal only keep following from the bottom.
    const appended = messages.length !== messageCountRef.current;
    messageCountRef.current = messages.length;
    if (appended) nearBottomRef.current = true;
    if (!nearBottomRef.current) return;
    // Immediate pin (reveal ticks outrun the debounce below), then a trailing
    // animated settle once the burst pauses and layout has caught up.
    scrollRef.current?.scrollToEnd({ animated: false });
    const timer = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      40,
    );
    return () => clearTimeout(timer);
  }, [messages]);

  // The sticky composer rides up OVER the thread when the keyboard opens; the
  // scroll area itself never shrinks. Track the keyboard so the thread can
  // reserve the covered strip, otherwise the newest messages hide behind the
  // keyboard with no way to scroll down to them.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const setFrom = (event: { height: number }) =>
      setKeyboardHeight(event.height);
    const clear = () => setKeyboardHeight(0);
    const subs = [
      KeyboardEvents.addListener("keyboardWillShow", setFrom),
      KeyboardEvents.addListener("keyboardDidShow", setFrom),
      KeyboardEvents.addListener("keyboardWillHide", clear),
      KeyboardEvents.addListener("keyboardDidHide", clear),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  useEffect(() => {
    // Opening the keyboard from the bottom of the thread keeps the newest
    // message pinned just above the composer (readers who scrolled up are
    // left alone). Immediate jump, then an animated settle once the newly
    // reserved space has laid out.
    if (keyboardHeight <= 0 || !nearBottomRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
    const timer = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      90,
    );
    return () => clearTimeout(timer);
  }, [keyboardHeight]);

  // Android/web hear pick errors via the box's live region; iOS has no live
  // regions, so the message is announced explicitly there.
  useEffect(() => {
    if (photoError && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(photoError);
    }
  }, [photoError]);

  // iOS has no live regions: announce the paused notice explicitly there.
  useEffect(() => {
    if (coachPaused && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(coachPaused.message);
    }
  }, [coachPaused]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || isStreaming || coachPaused) return;
    Haptics.selectionAsync();
    setDraft("");
    send(text);
  };

  const usePickedPhoto = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]) return;
    setPreparing(true);
    try {
      const photo = await preparePhotoForUpload(result.assets[0]);
      setPhotoError(null);
      setPhotoOptionsOpen(false);
      sendPhoto(photo);
    } catch (error) {
      console.error("Chat photo preparation failed", error);
      setPhotoError(
        "That photo could not be prepared. Please try a different one.",
      );
    } finally {
      setPreparing(false);
    }
  };

  // ── The in-app camera path: stage the shot, confirm once, send ──────────

  const stageCapture = async (capture: FoodCameraCapture) => {
    setPreparing(true);
    try {
      const prepared = await preparePhotoForUpload(capture.asset);
      setPhotoError(null);
      stagedSourceRef.current = capture.source;
      setStagedPhoto(prepared);
    } catch (error) {
      console.error("Chat photo preparation failed", error);
      setPhotoError(
        "That photo could not be prepared. Please try a different one.",
      );
    } finally {
      setPreparing(false);
    }
  };

  const takePhoto = async () => {
    Haptics.selectionAsync();
    setPhotoError(null);
    // The app's own full-screen camera (app/food-camera) owns permission
    // prompts and the denied fallback, and its corner button already offers
    // the library, so this control never dead-ends. Whichever shot or pick
    // comes back is staged behind the single blue confirmation; null means
    // the patient closed the camera without choosing.
    const request = createFoodCameraRequest();
    router.push("/food-camera");
    const capture = await request;
    if (!capture) return;
    await stageCapture(capture);
  };

  // The patient FAB's "Snap a meal photo" row deep-links here with
  // camera=1: run the exact takePhoto flow once on arrival so the shot
  // lands in this conversation like any other camera capture. The ref
  // guards re-renders; a fresh mount with the param (e.g. reloading that
  // URL on web) intentionally reopens the camera. takePhoto is recreated
  // per render, so the ref — not the dep list — makes this once-only.
  const deepLinkParams = useLocalSearchParams<{ camera?: string }>();
  const autoCameraRan = useRef(false);
  useEffect(() => {
    if (deepLinkParams.camera !== "1" || autoCameraRan.current) return;
    autoCameraRan.current = true;
    void takePhoto();
  }, [deepLinkParams.camera]);

  // "Choose a different photo" under the staged preview: back into the
  // library picker, but staging the pick (unlike the send-straight-away
  // library chip in the options row).
  const restageFromLibrary = async () => {
    setPhotoError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPhotoError("Photo library permission was declined.");
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      if (result.canceled || !result.assets?.[0]) return;
      await stageCapture({ asset: result.assets[0], source: "library" });
    } catch (error) {
      console.error("Photo library launch failed", error);
      setPhotoError(
        "Your photo library could not be opened. Please try again.",
      );
    }
  };

  const retakeStagedPhoto = () => {
    Haptics.selectionAsync();
    setStagedPhoto(null);
    if (stagedSourceRef.current === "camera") void takePhoto();
    else void restageFromLibrary();
  };

  const confirmStagedPhoto = () => {
    if (!stagedPhoto || isStreaming) return;
    Haptics.selectionAsync();
    sendPhoto(stagedPhoto);
    setStagedPhoto(null);
    setPhotoError(null);
    setPhotoOptionsOpen(false);
  };

  const discardStagedPhoto = () => {
    Haptics.selectionAsync();
    setStagedPhoto(null);
    setPhotoError(null);
  };

  const choosePhoto = async () => {
    Haptics.selectionAsync();
    setPhotoError(null);
    if (Platform.OS !== "web") {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setPhotoError("Photo library permission was declined.");
        return;
      }
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
        base64: Platform.OS === "web",
      });
      await usePickedPhoto(result);
    } catch (error) {
      console.error("Photo library launch failed", error);
      setPhotoError(
        "Your photo library could not be opened. Please try again.",
      );
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.headerBand,
          {
            backgroundColor: colors.paperCardAlt,
            borderBottomColor: colors.border,
            paddingTop: topPad,
          },
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            testID="coach-back"
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={() => {
              Haptics.selectionAsync();
              router.back();
            }}
            style={({ pressed }) => [
              styles.backBtn,
              {
                borderColor: colors.border,
                backgroundColor: colors.card,
                borderRadius: colors.radiusSm,
              },
              pressed && { backgroundColor: colors.accent },
            ]}
          >
            <Feather name="chevron-left" size={18} color={colors.navy} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerLabel, { color: colors.labelText }]}>
              THINNR COACH
            </Text>
            <View style={styles.headerTitleRow}>
              <Text style={[styles.headerTitle, { color: colors.navy }]}>
                Coach
              </Text>
              <View style={[styles.aiBadge, { borderColor: colors.cobalt }]}>
                <Text style={[styles.aiBadgeText, { color: colors.cobalt }]}>
                  AI
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.backBtnSpacer} />
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.thread}
        showsVerticalScrollIndicator={false}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          nearBottomRef.current =
            contentOffset.y + layoutMeasurement.height >=
            contentSize.height - 80;
        }}
        scrollEventThrottle={32}
      >
        <View
          style={[
            styles.disclosureCard,
            {
              borderColor: colors.border,
              backgroundColor: colors.card,
              borderRadius: colors.radius,
              boxShadow: CARD_SHADOW,
            },
          ]}
        >
          <Text style={[styles.disclosureLabel, { color: colors.labelText }]}>
            AI COACH · PLEASE NOTE
          </Text>
          <Text style={[styles.disclosureBody, { color: colors.bodyText }]}>
            This coach is an AI assistant, for information only, not medical
            advice. Answers come from the official THINNR program materials. It
            can make mistakes, so check with your care team when something
            matters.
          </Text>
        </View>

        {/* A hidden greeting stays in state (and request history) but off
            screen: photo-opened sessions start with the photo itself. */}
        {messages
          .filter((message) => !message.hidden)
          .map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        {/* Until the patient joins in, the starter prompts sit under the
            seeded greeting as ready-made conversation openers. */}
        {hasUserMessage ? null : (
          <View style={styles.starterBlock}>
            <Text style={[styles.starterLabel, { color: colors.labelText }]}>
              TRY ASKING
            </Text>
            {STARTER_PROMPTS.map((prompt) => (
              <Pressable
                key={prompt}
                testID={`coach-starter-${STARTER_PROMPTS.indexOf(prompt)}`}
                onPress={() => {
                  Haptics.selectionAsync();
                  send(prompt);
                }}
                style={({ pressed }) => [
                  styles.starterChip,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.card,
                    borderRadius: colors.radiusSm,
                    boxShadow: CHIP_SHADOW,
                  },
                  pressed && { backgroundColor: colors.accent },
                ]}
              >
                <Feather
                  name="message-circle"
                  size={13}
                  color={colors.orange}
                />
                <Text style={[styles.starterText, { color: colors.navy }]}>
                  {prompt}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {/* One chip row under the newest finished reply. A meal-photo reply
            grows a client-side "Retake photo" chip (quick replies only send
            text, so the "new shot" affordance lives here); a reply that
            closes with a question grows one-tap quick replies, server-curated
            labels first. A meal reply with off-list items ends with the
            makeover offer AND carries the card, so BOTH appear side by side
            in this one wrapping row — chip taps send their exact label as
            text (the server's follow-up detectors key on those labels), and
            the retake chip keeps its fresh-capture role alongside. */}
        {offersQuickReplies(messages[messages.length - 1], isStreaming) ||
        offersMealPhotoRetake(messages, isStreaming) ? (
          <View style={styles.quickReplyRow}>
            {offersQuickReplies(messages[messages.length - 1], isStreaming)
              ? quickRepliesFor(messages[messages.length - 1]).map(
                  (reply, index) => (
                    <Pressable
                      key={reply}
                      testID={`coach-quick-reply-${index}`}
                      accessibilityRole="button"
                      onPress={() => {
                        Haptics.selectionAsync();
                        send(reply);
                      }}
                      style={({ pressed }) => [
                        styles.quickReplyChip,
                        {
                          borderColor: colors.activeBorder,
                          backgroundColor: colors.activeBg,
                          borderRadius: colors.radiusSm,
                        },
                        pressed && { backgroundColor: colors.accent },
                      ]}
                    >
                      <Text
                        style={[
                          styles.quickReplyText,
                          { color: colors.cobalt },
                        ]}
                      >
                        {reply}
                      </Text>
                    </Pressable>
                  ),
                )
              : null}
            {offersMealPhotoRetake(messages, isStreaming) ? (
              <MealPhotoButton variant="chip" testID="coach-meal-retake" />
            ) : null}
          </View>
        ) : null}

        {keyboardHeight > 0 ? (
          <View
            // Reserve exactly the strip the risen composer + keyboard cover
            // (the composer already spans the home-indicator inset).
            style={{ height: Math.max(keyboardHeight - insets.bottom, 0) }}
          />
        ) : null}
      </ScrollView>

      <InputAboveKeyboard bottomInset={insets.bottom}>
        <View
          style={[
            styles.inputBar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.card,
              paddingBottom: Math.max(insets.bottom, 12) + 4,
            },
          ]}
        >
          {coachPaused ? (
            <View
              testID="coach-paused-notice"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[
                styles.pausedBox,
                {
                  backgroundColor: colors.warnBg,
                  borderColor: colors.warnBorder,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Feather
                name="pause-circle"
                size={14}
                color={colors.warnText}
                style={styles.photoErrorIcon}
              />
              <View style={styles.pausedCopy}>
                <Text style={[styles.pausedTitle, { color: colors.warnText }]}>
                  Coach paused by your care team
                </Text>
                <Text style={[styles.pausedText, { color: colors.warnText }]}>
                  {coachPaused.message}
                </Text>
              </View>
            </View>
          ) : null}
          {photoError && !coachPaused ? (
            <View
              testID="coach-photo-error"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[
                styles.photoErrorBox,
                {
                  backgroundColor: colors.riskBg,
                  borderColor: colors.riskBorder,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Feather
                name="alert-triangle"
                size={13}
                color={colors.riskText}
                style={styles.photoErrorIcon}
              />
              <Text style={[styles.photoErrorText, { color: colors.riskText }]}>
                {photoError}
              </Text>
            </View>
          ) : null}
          {photoOptionsOpen && !coachPaused ? (
            <View style={styles.photoOptionsRow}>
              {Platform.OS !== "web" ? (
                <Pressable
                  testID="coach-photo-take"
                  accessibilityRole="button"
                  disabled={isStreaming || preparing}
                  onPress={takePhoto}
                  style={({ pressed }) => [
                    styles.photoOptionChip,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.card,
                      borderRadius: colors.radiusSm,
                      boxShadow: CHIP_SHADOW,
                    },
                    (isStreaming || preparing) && { opacity: 0.5 },
                    pressed && { backgroundColor: colors.accent },
                  ]}
                >
                  <Feather name="camera" size={13} color={colors.orange} />
                  <Text
                    style={[styles.photoOptionText, { color: colors.navy }]}
                  >
                    Take a photo
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                testID="coach-photo-choose"
                accessibilityRole="button"
                disabled={isStreaming || preparing}
                onPress={choosePhoto}
                style={({ pressed }) => [
                  styles.photoOptionChip,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.card,
                    borderRadius: colors.radiusSm,
                    boxShadow: CHIP_SHADOW,
                  },
                  (isStreaming || preparing) && { opacity: 0.5 },
                  pressed && { backgroundColor: colors.accent },
                ]}
              >
                <Feather name="image" size={13} color={colors.orange} />
                <Text style={[styles.photoOptionText, { color: colors.navy }]}>
                  {Platform.OS === "web"
                    ? "Choose a photo"
                    : "Choose from library"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <Pressable
              testID="coach-photo"
              accessibilityRole="button"
              accessibilityLabel="Send a photo"
              accessibilityState={{
                disabled: isStreaming || preparing || !!coachPaused,
                expanded: photoOptionsOpen,
              }}
              disabled={isStreaming || preparing || !!coachPaused}
              onPress={() => {
                Haptics.selectionAsync();
                setPhotoError(null);
                setPhotoOptionsOpen((open) => !open);
              }}
              style={({ pressed }) => [
                styles.cameraBtn,
                {
                  borderColor: photoOptionsOpen
                    ? colors.activeBorder
                    : colors.border,
                  backgroundColor: photoOptionsOpen
                    ? colors.activeBg
                    : colors.card,
                  borderRadius: colors.radiusSm,
                },
                pressed && { backgroundColor: colors.accent },
              ]}
            >
              {preparing ? (
                <ActivityIndicator size="small" color={colors.cobalt} />
              ) : (
                <Feather
                  name="camera"
                  size={17}
                  color={
                    isStreaming || coachPaused
                      ? colors.subtleText
                      : colors.cobalt
                  }
                />
              )}
            </Pressable>
            <TextInput
              testID="coach-input"
              value={draft}
              onChangeText={setDraft}
              placeholder={
                coachPaused ? "Coach paused by your care team" : "Message your coach"
              }
              placeholderTextColor={colors.subtleText}
              editable={!isStreaming && !coachPaused}
              accessibilityState={{ disabled: !!coachPaused }}
              returnKeyType="send"
              onSubmitEditing={submitDraft}
              submitBehavior="submit"
              style={[
                styles.input,
                {
                  borderColor: colors.input,
                  backgroundColor: colors.background,
                  color: colors.navy,
                  borderRadius: colors.radiusSm,
                },
              ]}
            />
            {isStreaming ? (
              <Pressable
                testID="coach-stop"
                accessibilityRole="button"
                accessibilityLabel="Stop response"
                onPress={() => {
                  Haptics.selectionAsync();
                  stop();
                }}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor: colors.navy,
                    borderRadius: colors.radiusSm,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <View
                  style={[
                    styles.stopGlyph,
                    { backgroundColor: colors.primaryForeground },
                  ]}
                />
              </Pressable>
            ) : (
              <Pressable
                testID="coach-send"
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{
                  disabled: draft.trim().length === 0 || !!coachPaused,
                }}
                disabled={draft.trim().length === 0 || !!coachPaused}
                onPress={submitDraft}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor:
                      draft.trim().length === 0 || coachPaused
                        ? colors.cobaltMuted
                        : colors.cobalt,
                    borderRadius: colors.radiusSm,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Feather
                  name="arrow-up"
                  size={18}
                  color={colors.primaryForeground}
                />
              </Pressable>
            )}
          </View>
        </View>
      </InputAboveKeyboard>

      {/* ── The single blue confirmation for camera captures and corner
          library picks (the library chip and web picks send straight away,
          as before). ── */}
      <AppModal
        visible={stagedPhoto !== null}
        transparent
        animationType="fade"
        onRequestClose={discardStagedPhoto}
      >
        <View style={styles.previewBackdrop}>
          <View
            testID="coach-photo-preview"
            style={[
              styles.previewSheet,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
              },
            ]}
          >
            <Text style={[styles.previewLabel, { color: colors.labelText }]}>
              YOUR PHOTO
            </Text>
            {stagedPhoto ? (
              <Image
                source={{ uri: stagedPhoto.uri }}
                style={[
                  styles.previewPhoto,
                  {
                    aspectRatio: stagedAspect(stagedPhoto),
                    borderRadius: colors.radiusSm,
                    backgroundColor: colors.paperCardAlt,
                  },
                ]}
                contentFit="cover"
                accessibilityLabel="Preview of your photo"
              />
            ) : null}
            <Text style={[styles.previewHint, { color: colors.subtleText }]}>
              The AI coach will look at this photo and reply to what it sees,
              whether that is a plate, a menu, or a nutrition label. Photos
              are analyzed once, never stored.
            </Text>
            <Pressable
              testID="coach-photo-use"
              accessibilityRole="button"
              accessibilityLabel="Use this photo"
              accessibilityState={{ disabled: isStreaming }}
              disabled={isStreaming}
              onPress={confirmStagedPhoto}
              style={({ pressed }) => [
                styles.previewPrimaryBtn,
                {
                  backgroundColor: isStreaming
                    ? colors.cobaltMuted
                    : colors.cobalt,
                  borderRadius: colors.radiusSm,
                },
                pressed && !isStreaming && { opacity: 0.88 },
              ]}
            >
              <Feather name="send" size={14} color={colors.primaryForeground} />
              <Text
                style={[
                  styles.previewPrimaryText,
                  { color: colors.primaryForeground },
                ]}
              >
                Use this photo
              </Text>
            </Pressable>
            <Pressable
              testID="coach-photo-retake"
              accessibilityRole="button"
              accessibilityLabel={
                stagedSourceRef.current === "camera"
                  ? "Retake the photo"
                  : "Choose a different photo"
              }
              disabled={preparing}
              onPress={retakeStagedPhoto}
              style={({ pressed }) => [
                styles.previewSecondaryBtn,
                {
                  borderColor: colors.border,
                  backgroundColor: pressed ? colors.accent : colors.card,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              {preparing ? (
                <ActivityIndicator size="small" color={colors.navyLight} />
              ) : null}
              <Text
                style={[
                  styles.previewSecondaryText,
                  { color: colors.navyLight },
                ]}
              >
                {stagedSourceRef.current === "camera"
                  ? "Retake"
                  : "Choose a different photo"}
              </Text>
            </Pressable>
            <Pressable
              testID="coach-photo-discard"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={discardStagedPhoto}
              hitSlop={6}
              style={({ pressed }) => [
                styles.previewCancelLink,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[styles.previewCancelText, { color: colors.subtleText }]}
              >
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      </AppModal>
    </View>
  );
}

/**
 * Assistant replies arrive as short thought blocks separated by blank lines
 * (the server prompt asks for that shape). Split on blank lines so each
 * thought renders as its own paragraph with breathing room. While streaming,
 * the trailing partial block simply grows in place; whitespace-only
 * fragments (e.g. a just-arrived blank line) are skipped rather than
 * rendered as empty paragraphs.
 */
function splitIntoBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Waiting-bubble captions for the photo-turn stage narration. Coach voice:
 * warm, plain, no dashes, never a question. "received" appears the instant
 * the photo leaves the device (set locally, before the stream even opens);
 * the reading lines land once the server names the pipeline.
 */
const STAGE_LINES: Record<CoachStage, string> = {
  received: "Got your photo, taking a look…",
  reading_meal: "Sizing up your plate…",
  reading_menu: "Reading the menu…",
  reading_label: "Reading the label…",
};

function MessageBubble({ message }: { message: CoachMessage }) {
  const colors = useColors();
  const { isStreaming, pendingStage, retry } = useCoachChat();
  const isUser = message.role === "user";

  if (isUser) {
    if (message.photo && !message.photo.reused) {
      // Photo turns render the picture itself; the message's fixed text is
      // only what the model reads when the thread is replayed later. A
      // typed-correction turn is the exception: its photo is a re-used copy
      // of one already on screen upthread, so the bubble shows the typed
      // words and falls through to the text branch below.
      const aspect = Math.min(
        Math.max(message.photo.width / Math.max(message.photo.height, 1), 0.62),
        1.7,
      );
      return (
        <View
          testID={`coach-photo-bubble-${message.id}`}
          style={[
            styles.bubble,
            styles.userBubble,
            styles.photoBubble,
            {
              backgroundColor: colors.cobalt,
              borderRadius: colors.radius,
              borderBottomRightRadius: 3,
            },
          ]}
        >
          <Image
            source={{ uri: message.photo.uri }}
            style={[
              styles.bubblePhoto,
              {
                aspectRatio: aspect,
                borderRadius: colors.radius - 3,
                backgroundColor: colors.paperCardAlt,
              },
            ]}
            contentFit="cover"
            accessibilityLabel={
              message.photo.kind === "meal"
                ? "Your meal photo"
                : message.photo.kind === "menu"
                  ? "Your menu photo"
                  : message.photo.kind === "label"
                    ? "Your nutrition label photo"
                    : "Your photo"
            }
          />
        </View>
      );
    }
    return (
      <View
        style={[
          styles.bubble,
          styles.userBubble,
          {
            backgroundColor: colors.cobalt,
            borderRadius: colors.radius,
            borderBottomRightRadius: 3,
          },
        ]}
      >
        <Text style={[styles.bubbleText, { color: colors.primaryForeground }]}>
          {message.text}
        </Text>
      </View>
    );
  }

  const isError = message.status === "error";
  const blocks = splitIntoBlocks(message.text);
  const isThinking = message.status === "streaming" && blocks.length === 0;
  return (
    <View
      style={[
        styles.bubble,
        styles.assistantBubble,
        {
          backgroundColor: isError ? colors.riskBg : colors.card,
          borderColor: isError ? colors.riskBorder : colors.border,
          borderRadius: colors.radius,
          borderBottomLeftRadius: 3,
          boxShadow: BUBBLE_SHADOW,
        },
      ]}
    >
      {isThinking ? (
        // While the reply is still silent, a photo turn narrates its wait:
        // the pulsing marks stay, and the current stage captions them. Text
        // turns keep the bare indicator (pendingStage is null there). No
        // live region — the stages are glanceable progress, not something
        // to interrupt a screen reader with mid-wait.
        <View style={styles.thinkingStack}>
          <ThinkingIndicator color={colors.cobalt} />
          {pendingStage ? (
            <Text style={[styles.stageLabel, { color: colors.subtleText }]}>
              {STAGE_LINES[pendingStage]}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.blockStack}>
          {blocks.map((block, index) => (
            <Text
              key={index}
              style={[
                styles.bubbleText,
                { color: isError ? colors.riskText : colors.navy },
              ]}
            >
              {block}
            </Text>
          ))}
        </View>
      )}
      {message.stopped ? (
        <Text style={[styles.stoppedLabel, { color: colors.subtleText }]}>
          STOPPED
        </Text>
      ) : null}
      {message.card ? <CoachCardSlot card={message.card} messageId={message.id} /> : null}
      {/* Final failures (retryable === false, e.g. the daily budget is spent
          until tomorrow) hide the chip — the message already says waiting is
          the only fix, so offering RETRY would invite pointless taps. */}
      {isError && !isStreaming && message.retryable !== false ? (
        <Pressable
          testID={`coach-retry-${message.id}`}
          accessibilityRole="button"
          accessibilityLabel="Retry your question"
          onPress={() => {
            Haptics.selectionAsync();
            retry(message.id);
          }}
          style={({ pressed }) => [
            styles.retryBtn,
            {
              borderColor: colors.riskBorder,
              backgroundColor: pressed ? colors.accent : colors.card,
              borderRadius: colors.radiusSm,
            },
          ]}
        >
          <Feather name="refresh-cw" size={11} color={colors.riskText} />
          <Text style={[styles.retryText, { color: colors.riskText }]}>
            RETRY
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Same pattern as onboarding: pin the input above the keyboard on native. */
function InputAboveKeyboard({
  bottomInset,
  children,
}: {
  bottomInset: number;
  children: React.ReactNode;
}) {
  if (Platform.OS === "web") {
    return <>{children}</>;
  }
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: bottomInset }}>
      {children}
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerBand: {
    borderBottomWidth: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  backBtn: {
    width: 44,
    height: 44,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backBtnSpacer: {
    width: 44,
  },
  headerCenter: {
    alignItems: "center",
  },
  headerLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    fontFamily: "Inter_700Bold",
  },
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "PlayfairDisplay_700Bold",
    letterSpacing: 0.2,
  },
  aiBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  aiBadgeText: {
    fontSize: 8.5,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.8,
  },
  scroll: {
    flex: 1,
  },
  thread: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
    gap: 10,
  },
  disclosureCard: {
    borderWidth: 1,
    padding: 14,
    marginBottom: 6,
  },
  disclosureLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    fontFamily: "Inter_700Bold",
    marginBottom: 6,
  },
  disclosureBody: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  starterBlock: {
    marginTop: 10,
    gap: 8,
  },
  starterLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    fontFamily: "Inter_700Bold",
    marginBottom: 2,
  },
  starterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  starterText: {
    fontSize: 13.5,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  quickReplyRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  quickReplyChip: {
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  quickReplyText: {
    fontSize: 13,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  bubble: {
    maxWidth: "82%",
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  userBubble: {
    alignSelf: "flex-end",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    borderWidth: 1,
  },
  blockStack: {
    gap: 9,
  },
  bubbleText: {
    fontSize: 14.5,
    lineHeight: 21,
    fontFamily: "Inter_400Regular",
  },
  stoppedLabel: {
    fontSize: 8.5,
    fontWeight: "700",
    letterSpacing: 1.2,
    fontFamily: "Inter_700Bold",
    marginTop: 7,
  },
  thinkingStack: {
    gap: 8,
  },
  stageLabel: {
    fontSize: 12.5,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.1,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 9,
  },
  retryText: {
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 1.1,
    fontFamily: "Inter_700Bold",
  },
  inputBar: {
    gap: 10,
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cameraBtn: {
    width: 42,
    height: 42,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  photoOptionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  photoOptionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  photoOptionText: {
    fontSize: 13,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  photoErrorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    padding: 10,
  },
  pausedBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    padding: 10,
    marginBottom: 8,
  },
  pausedCopy: {
    flex: 1,
    gap: 2,
  },
  pausedTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: "Inter_600SemiBold",
  },
  pausedText: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  photoErrorIcon: {
    marginTop: 2,
  },
  photoErrorText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  photoBubble: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    width: "68%",
  },
  bubblePhoto: {
    width: "100%",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  sendBtn: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  stopGlyph: {
    width: 12,
    height: 12,
    borderRadius: 1.5,
  },
  // ── The staged-photo confirmation sheet (mirrors MealPhotoButton's) ──
  previewBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 32, 46, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  previewSheet: {
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  previewLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    fontFamily: "Inter_700Bold",
  },
  previewPhoto: {
    width: "100%",
  },
  previewHint: {
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
  },
  previewPrimaryBtn: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  previewPrimaryText: {
    fontSize: 13.5,
    fontFamily: "Inter_600SemiBold",
  },
  previewSecondaryBtn: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  previewSecondaryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  previewCancelLink: {
    alignSelf: "center",
    minHeight: 24,
    justifyContent: "center",
  },
  previewCancelText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});
