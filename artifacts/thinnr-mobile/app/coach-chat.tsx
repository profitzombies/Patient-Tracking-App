/**
 * THINNR Coach — full-screen AI chat for patients.
 *
 * Cobalt Ledger styling: square geometry, Inter type, uppercase micro-labels,
 * no emojis anywhere. The disclosure card is pinned as the first thread item
 * and a compact AI badge sits in the header, so the assistant is always
 * clearly labeled as AI.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { CoachCardSlot } from '@/components/coach/CoachCardSlot';
// Side-effect imports: register the "product" and "recipe" card renderers
// into the card slot.
import '@/components/coach/ProductSuggestionCard';
import '@/components/coach/RecipeSuggestionCard';
import { useColors } from '@/hooks/useColors';
import { useCoachChat, type CoachMessage } from '@/context/CoachChatContext';

const STARTER_PROMPTS = [
  'What should I eat today?',
  'Is grapefruit approved?',
  'Give me a dinner idea for tonight',
  "I'm craving something sweet",
  'What do I order at a restaurant?',
];

const QUICK_REPLIES = ['Yes, please', 'No thanks'];

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
    latest.role === 'assistant' &&
    latest.status === 'done' &&
    latest.text.trimEnd().endsWith('?')
  );
}

export default function CoachChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { messages, isStreaming, send, stop } = useCoachChat();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  useEffect(() => {
    // Follow the newest message (and each streamed chunk) to the bottom.
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 40);
    return () => clearTimeout(timer);
  }, [messages]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    Haptics.selectionAsync();
    setDraft('');
    send(text);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
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
            { borderColor: colors.border, backgroundColor: colors.card },
            pressed && { backgroundColor: colors.accent },
          ]}
        >
          <Feather name="chevron-left" size={18} color={colors.navy} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerLabel, { color: colors.labelText }]}>THINNR COACH</Text>
          <View style={styles.headerTitleRow}>
            <Text style={[styles.headerTitle, { color: colors.navy }]}>Coach</Text>
            <View style={[styles.aiBadge, { borderColor: colors.cobalt }]}>
              <Text style={[styles.aiBadgeText, { color: colors.cobalt }]}>AI</Text>
            </View>
          </View>
        </View>
        <View style={styles.backBtnSpacer} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.thread}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[
            styles.disclosureCard,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
        >
          <Text style={[styles.disclosureLabel, { color: colors.labelText }]}>
            AI COACH · PLEASE NOTE
          </Text>
          <Text style={[styles.disclosureBody, { color: colors.bodyText }]}>
            This coach is an AI assistant, for information only — not medical advice. Answers
            come from the official THINNR program materials. It can make mistakes, so check with
            your care team when something matters.
          </Text>
        </View>

        {messages.length === 0 ? (
          <View style={styles.starterBlock}>
            <Text style={[styles.starterLabel, { color: colors.labelText }]}>TRY ASKING</Text>
            {STARTER_PROMPTS.map(prompt => (
              <Pressable
                key={prompt}
                testID={`coach-starter-${STARTER_PROMPTS.indexOf(prompt)}`}
                onPress={() => {
                  Haptics.selectionAsync();
                  send(prompt);
                }}
                style={({ pressed }) => [
                  styles.starterChip,
                  { borderColor: colors.border, backgroundColor: colors.card },
                  pressed && { backgroundColor: colors.accent },
                ]}
              >
                <Feather name="message-circle" size={13} color={colors.cobalt} />
                <Text style={[styles.starterText, { color: colors.navy }]}>{prompt}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <>
            {messages.map(message => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {offersQuickReplies(messages[messages.length - 1], isStreaming) ? (
              <View style={styles.quickReplyRow}>
                {QUICK_REPLIES.map((reply, index) => (
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
                      { borderColor: colors.cobalt, backgroundColor: colors.card },
                      pressed && { backgroundColor: colors.accent },
                    ]}
                  >
                    <Text style={[styles.quickReplyText, { color: colors.cobalt }]}>{reply}</Text>
                  </Pressable>
                ))}
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
              borderTopColor: colors.divider,
              backgroundColor: colors.background,
              paddingBottom: Math.max(insets.bottom, 12) + 4,
            },
          ]}
        >
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
                backgroundColor: colors.card,
                color: colors.navy,
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
                { backgroundColor: colors.navy },
                pressed && { opacity: 0.85 },
              ]}
            >
              <View
                style={[styles.stopGlyph, { backgroundColor: colors.primaryForeground }]}
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
                    draft.trim().length === 0 ? colors.cobaltMuted : colors.cobalt,
                },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Feather name="arrow-up" size={18} color={colors.primaryForeground} />
            </Pressable>
          )}
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
    .map(block => block.trim())
    .filter(block => block.length > 0);
}

function MessageBubble({ message }: { message: CoachMessage }) {
  const colors = useColors();
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: colors.cobalt }]}>
        <Text style={[styles.bubbleText, { color: colors.primaryForeground }]}>{message.text}</Text>
      </View>
    );
  }

  const isError = message.status === 'error';
  const blocks = splitIntoBlocks(message.text);
  const isThinking = message.status === 'streaming' && blocks.length === 0;
  return (
    <View
      style={[
        styles.bubble,
        styles.assistantBubble,
        {
          backgroundColor: isError ? colors.riskBg : colors.card,
          borderColor: isError ? colors.riskBorder : colors.border,
        },
      ]}
    >
      {isThinking ? (
        <Text style={[styles.thinkingText, { color: colors.subtleText }]}>Thinking…</Text>
      ) : (
        <View style={styles.blockStack}>
          {blocks.map((block, index) => (
            <Text
              key={index}
              style={[styles.bubbleText, { color: isError ? colors.riskText : colors.navy }]}
            >
              {block}
            </Text>
          ))}
        </View>
      )}
      {message.card ? <CoachCardSlot card={message.card} /> : null}
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
  if (Platform.OS === 'web') {
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  backBtn: {
    width: 44,
    height: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnSpacer: {
    width: 44,
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  aiBadge: {
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  aiBadgeText: {
    fontSize: 8.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
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
    width: '100%',
    alignSelf: 'center',
    gap: 10,
  },
  disclosureCard: {
    borderWidth: 1,
    padding: 14,
    marginBottom: 6,
  },
  disclosureLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    marginBottom: 6,
  },
  disclosureBody: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  starterBlock: {
    marginTop: 10,
    gap: 8,
  },
  starterLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  starterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  starterText: {
    fontSize: 13.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  quickReplyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickReplyChip: {
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  quickReplyText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  bubble: {
    maxWidth: '82%',
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  userBubble: {
    alignSelf: 'flex-end',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    borderWidth: 1,
  },
  blockStack: {
    gap: 9,
  },
  bubbleText: {
    fontSize: 14.5,
    lineHeight: 21,
    fontFamily: 'Inter_400Regular',
  },
  thinkingText: {
    fontSize: 13.5,
    lineHeight: 20,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  sendBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopGlyph: {
    width: 12,
    height: 12,
  },
});
