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
 * Photo turns: the camera button beside the input sends a menu photo into
 * the conversation (take or choose, downscaled by the shared photo-prep
 * helper), rendered as a photo bubble. The coach replies with ordering
 * suggestions and offers a custom recipe via the usual one-tap chips. The
 * photo stays in client state, so a failed turn retries in one tap.
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
  TextInput,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { CoachCardSlot } from "@/components/coach/CoachCardSlot";
import { ThinkingIndicator } from "@/components/coach/ThinkingIndicator";
// Side-effect imports: register the "product" and "recipe" card renderers
// into the card slot.
import "@/components/coach/ProductSuggestionCard";
import "@/components/coach/RecipeSuggestionCard";
import { useColors } from "@/hooks/useColors";
import { useCoachChat, type CoachMessage } from "@/context/CoachChatContext";
import { preparePhotoForUpload } from "@/lib/photo-prep";

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
 * therefore hides the chips automatically.
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
export default function CoachChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { messages, isStreaming, send, sendPhoto, stop } = useCoachChat();
  const [draft, setDraft] = useState("");
  const [photoOptionsOpen, setPhotoOptionsOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Reveal ticks change `messages` ~30×/s while a reply types out; only pin
  // to the bottom while the patient is already reading there, so scrolling
  // up to re-read older answers never fights the typing animation.
  const nearBottomRef = useRef(true);
  const messageCountRef = useRef(0);

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top;

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

  // Android/web hear pick errors via the box's live region; iOS has no live
  // regions, so the message is announced explicitly there.
  useEffect(() => {
    if (photoError && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(photoError);
    }
  }, [photoError]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
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
      console.error("Menu photo preparation failed", error);
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
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setPhotoError(
        "Camera permission was declined. You can still choose a photo from your library.",
      );
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      await usePickedPhoto(result);
    } catch (error) {
      console.error("Camera launch failed", error);
      setPhotoError(
        "The camera could not be opened. Try choosing a photo instead.",
      );
    }
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
            This coach is an AI assistant, for information only — not medical
            advice. Answers come from the official THINNR program materials. It
            can make mistakes, so check with your care team when something
            matters.
          </Text>
        </View>

        {messages.length === 0 ? (
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
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {offersQuickReplies(messages[messages.length - 1], isStreaming) ? (
              <View style={styles.quickReplyRow}>
                {quickRepliesFor(messages[messages.length - 1]).map(
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
                )}
              </View>
            ) : null}
          </>
        )}
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
          {photoError ? (
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
          {photoOptionsOpen ? (
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
                    ? "Choose a menu photo"
                    : "Choose from library"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <Pressable
              testID="coach-photo"
              accessibilityRole="button"
              accessibilityLabel="Send a menu photo"
              accessibilityState={{
                disabled: isStreaming || preparing,
                expanded: photoOptionsOpen,
              }}
              disabled={isStreaming || preparing}
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
                  color={isStreaming ? colors.subtleText : colors.cobalt}
                />
              )}
            </Pressable>
            <TextInput
              testID="coach-input"
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask about the program"
              placeholderTextColor={colors.subtleText}
              editable={!isStreaming}
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
                disabled={draft.trim().length === 0}
                onPress={submitDraft}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor:
                      draft.trim().length === 0
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

function MessageBubble({ message }: { message: CoachMessage }) {
  const colors = useColors();
  const { isStreaming, retry } = useCoachChat();
  const isUser = message.role === "user";

  if (isUser) {
    if (message.photo) {
      // Photo turns render the picture itself; the message's fixed text is
      // only what the model reads when the thread is replayed later.
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
            accessibilityLabel="Your menu photo"
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
        <ThinkingIndicator color={colors.cobalt} />
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
      {message.card ? <CoachCardSlot card={message.card} /> : null}
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
});
