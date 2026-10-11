/**
 * AI Support — full-screen staff chat over the HQ knowledge library, reached
 * from the provider FAB menu. The mobile sibling of the operations web page.
 *
 * Heritage styling matches the patient coach chat (paper assistant bubbles,
 * cobalt user bubbles, serif title, AI badge), but replies render markdown —
 * the support persona answers comprehensively with headings, bullets and
 * bold, grounded ONLY in the documents HQ uploaded.
 *
 * Reliability contract mirrors the web client: streamed deltas, a Stop
 * button that keeps the partial text (flagged stopped for the model), errors
 * replace the reply with a retryable notice, and a dropped stream never
 * finalizes as a complete answer.
 *
 * Persistence follows the account seam: signed-out visits start fresh by
 * design, exactly like the web page, but a signed-in REAL account keeps its
 * support thread — finalized messages (user turns, done replies, stopped
 * ones included; never streaming or error bubbles) append to the account,
 * and reopening the screen loads the stored transcript back.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
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
import { Redirect, useFocusEffect, usePathname, useRouter } from "expo-router";
import { ThinkingIndicator } from "@/components/coach/ThinkingIndicator";
import { SupportMarkdown } from "@/components/provider/SupportMarkdown";
import { useColors } from "@/hooks/useColors";
import { useAppMode } from "@/context/AppModeContext";
import {
  usePatientAccount,
  type ChatWireMessage,
} from "@/context/PatientAccountContext";
import { localTodayKey } from "@/lib/live-patient-entry";
import {
  MAX_SUPPORT_QUESTION_LENGTH,
  SUPPORT_HISTORY_WINDOW,
  streamSupportChat,
  toSupportHistoryContent,
  type SupportRequestMessage,
} from "@/lib/support-api";
import { subscribeChatSync } from "@/lib/chat-sync-events";

/** Heritage soft shadows as boxShadow strings (shadow* props warn on web). */
const CARD_SHADOW = "0 8px 20px rgba(40, 55, 74, 0.07)";
const BUBBLE_SHADOW = "0 5px 12px rgba(35, 61, 95, 0.07)";
const CHIP_SHADOW = "0 5px 12px rgba(35, 61, 95, 0.08)";

/** Same starters the operations web page offers. */
const SUGGESTED_QUESTIONS = [
  "What foods are approved during the thinning phase?",
  "How should a patient take Boost, and when?",
  "A patient reports headaches in week one. What does the protocol say?",
];

interface SupportMessage {
  id: number;
  role: "user" | "assistant" | "staff";
  text: string;
  senderLabel?: string;
  status: "streaming" | "done" | "error";
  /** The provider pressed Stop while this reply was streaming. */
  stopped?: boolean;
  /** False only when the server declared the failure final. */
  retryable?: boolean;
}

/**
 * Account-persistence wire shape for a support message. Ids on screen are
 * session-local numbers; `clientId` is the durable upsert key the account
 * stores. Support bubbles are plain text — no cards, photos, or chips.
 */
function supportWire(m: SupportMessage, clientId: string): ChatWireMessage {
  const wire: ChatWireMessage = { id: clientId, role: m.role, text: m.text };
  if (m.role === "staff" && m.senderLabel) wire.senderLabel = m.senderLabel;
  if (m.stopped) wire.stopped = true;
  return wire;
}

export default function SupportChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { mode, hydrated } = useAppMode();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const messagesRef = useRef<SupportMessage[]>(messages);
  const abortRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<number | null>(null);
  const idRef = useRef(0);
  const nearBottomRef = useRef(true);
  const messageCountRef = useRef(0);

  // Account seam: a signed-in real account persists this thread; everyone
  // else stays session-only. Same append/load pattern as the coach chat,
  // minus cards and photos.
  const { account, resolving } = usePatientAccount();
  const realAccount = !resolving && account.kind === "real" ? account : null;
  const accountApiRef = useRef(realAccount ? realAccount.api : null);
  accountApiRef.current = realAccount ? realAccount.api : null;
  // Session-local numeric id → durable client id (the account's upsert key).
  const clientIdsRef = useRef(new Map<number, string>());
  const sessionNonceRef = useRef(
    `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
  );
  // Wire signature of every message the account already stores, keyed by
  // client id; the persistence effect diffs against it.
  const persistedRef = useRef(new Map<string, string>());
  const outboxRef = useRef<number[]>([]);
  const flushingRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushFailuresRef = useRef(0);
  const hydratedThreadRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const clientIdFor = useCallback((localId: number) => {
    const existing = clientIdsRef.current.get(localId);
    if (existing) return existing;
    const created = `s${sessionNonceRef.current}-${localId}`;
    clientIdsRef.current.set(localId, created);
    return created;
  }, []);

  // Fresh view of the thread for the flush below. Declared BEFORE the
  // persistence effect so it runs first each commit — by the time an
  // enqueue triggers a flush, the ref already shows the render that
  // finalized the message (CoachChatContext orders these the same way; a
  // stale ref here silently drops just-finalized replies from the outbox).
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /**
   * Serial outbox flush (see CoachChatContext for the pattern): drains
   * queued local ids in thread order and appends their wire shapes to the
   * account, requeueing with a short backoff on failure and parking after
   * repeated failures until the next finalized message tries again.
   */
  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      while (outboxRef.current.length > 0) {
        const api = accountApiRef.current;
        if (!api) return;
        const batch = outboxRef.current.slice(0, 20);
        outboxRef.current = outboxRef.current.slice(batch.length);
        const wires: ChatWireMessage[] = [];
        const sigs: Array<[string, string]> = [];
        for (const localId of batch) {
          const m = messagesRef.current.find((x) => x.id === localId);
          if (!m || m.status !== "done" || m.role === "staff") continue;
          const wire = supportWire(m, clientIdFor(localId));
          wires.push(wire);
          sigs.push([wire.id, JSON.stringify(wire)]);
        }
        if (wires.length === 0) continue;
        try {
          await api.appendChatMessages("support", wires);
          for (const [cid, sig] of sigs) persistedRef.current.set(cid, sig);
          flushFailuresRef.current = 0;
        } catch {
          outboxRef.current = [...batch, ...outboxRef.current];
          flushFailuresRef.current += 1;
          if (flushFailuresRef.current < 5 && !flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              void flushOutbox();
            }, 5000);
          }
          return;
        }
      }
    } finally {
      flushingRef.current = false;
    }
    if (outboxRef.current.length > 0 && flushFailuresRef.current === 0) {
      void flushOutbox();
    }
  }, [clientIdFor]);

  const refreshThread = useCallback((): Promise<void> => {
    const api = accountApiRef.current;
    if (!api) return Promise.resolve();
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const request = api.fetchChatThread("support", localTodayKey()).then((snapshot) => {
      if (accountApiRef.current !== api) return;
      const restored: SupportMessage[] = [];
      for (const wire of snapshot.messages) {
        let localId: number | undefined;
        for (const [candidate, clientId] of clientIdsRef.current) {
          if (clientId === wire.id) {
            localId = candidate;
            break;
          }
        }
        if (localId === undefined) {
          localId = ++idRef.current;
          clientIdsRef.current.set(localId, wire.id);
        }
        const message: SupportMessage = {
          id: localId,
          role: wire.role,
          text: wire.text,
          status: "done",
          ...(wire.senderLabel ? { senderLabel: wire.senderLabel } : {}),
          ...(wire.stopped ? { stopped: true } : {}),
        };
        persistedRef.current.set(wire.id, JSON.stringify(supportWire(message, wire.id)));
        restored.push(message);
      }
      // First load: the stored transcript goes ahead of anything typed while
      // it was in flight. Later refreshes only append what the server has
      // that this screen has not seen yet (care-team replies).
      const firstLoad = !hydratedThreadRef.current;
      hydratedThreadRef.current = true;
      setMessages((current) => {
        const currentClientIds = new Set(
          current.map((message) => clientIdsRef.current.get(message.id)).filter(Boolean),
        );
        const additions = restored.filter(
          (message) => !currentClientIds.has(clientIdsRef.current.get(message.id)),
        );
        if (additions.length === 0) return current;
        return firstLoad ? [...additions, ...current] : [...current, ...additions];
      });
    }).finally(() => {
      refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = request;
    return request;
  }, []);

  // Hydration: load the account's stored support thread once per mount.
  // Failures retry a few times, then leave the screen session-only for this
  // visit (the next open tries again). Anything typed while the load ran
  // stays, appended after the stored transcript.
  useEffect(() => {
    if (!realAccount || hydratedThreadRef.current) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const run = async () => {
      try {
        await refreshThread();
      } catch {
        if (cancelled) return;
        attempts += 1;
        if (attempts < 4) retryTimer = setTimeout(() => void run(), 4000);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [realAccount, refreshThread]);

  useFocusEffect(
    useCallback(() => {
      if (realAccount) void refreshThread().catch(() => {});
    }, [realAccount, refreshThread]),
  );

  useEffect(() => {
    if (!realAccount) return;
    const appState = AppState.addEventListener("change", state => {
      if (state === "active") void refreshThread().catch(() => {});
    });
    const unsubscribe = subscribeChatSync(thread => {
      if (thread === "support") void refreshThread().catch(() => {});
    });
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [realAccount, refreshThread]);

  // Persistence: enqueue every finalized message whose wire shape the
  // account does not have yet — user turns at send, replies when they reach
  // `done` (stopped included). Streaming and error bubbles never persist.
  // Gated on hydration so nothing writes into a transcript never read.
  useEffect(() => {
    if (!realAccount || !hydratedThreadRef.current) return;
    let queued = false;
    for (const m of messages) {
      if (m.status !== "done" || m.role === "staff") continue;
      const sig = JSON.stringify(supportWire(m, clientIdFor(m.id)));
      if (persistedRef.current.get(clientIdFor(m.id)) === sig) continue;
      if (!outboxRef.current.includes(m.id)) {
        outboxRef.current.push(m.id);
        queued = true;
      }
    }
    if (queued) void flushOutbox();
  }, [messages, realAccount, clientIdFor, flushOutbox]);

  // Abandoning the screen mid-reply cancels the request; a parked retry
  // timer must not outlive the screen either.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top;
  const hasUserMessage = messages.some((m) => m.role === "user");

  useEffect(() => {
    // Follow the thread: always jump for a new bubble, and while a reply
    // streams only keep following from the bottom.
    const appended = messages.length !== messageCountRef.current;
    messageCountRef.current = messages.length;
    if (appended) nearBottomRef.current = true;
    if (!nearBottomRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
    const timer = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      40,
    );
    return () => clearTimeout(timer);
  }, [messages]);

  // The sticky composer rides up OVER the thread when the keyboard opens;
  // track the keyboard so the thread reserves the covered strip (same fix as
  // the coach chat).
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
    if (keyboardHeight <= 0 || !nearBottomRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
    const timer = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      90,
    );
    return () => clearTimeout(timer);
  }, [keyboardHeight]);

  const begin = (history: SupportMessage[], assistantId: number) => {
    const payload: SupportRequestMessage[] = history
      .slice(-SUPPORT_HISTORY_WINDOW)
      .map((message) => ({
        role: message.role,
        content:
          message.role === "assistant"
            ? toSupportHistoryContent(message.text)
            : message.text,
        ...(message.stopped ? { stopped: true } : {}),
      }));
    const controller = new AbortController();
    abortRef.current = controller;
    streamingIdRef.current = assistantId;
    setIsStreaming(true);

    const patch = (updates: Partial<SupportMessage>) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, ...updates } : message,
        ),
      );

    // Belt to the client's own abort suppression: a callback that raced a
    // Stop (or arrives after a newer request replaced this controller) must
    // never touch state — flipping isStreaming for a dead request would
    // re-enable sending while the live stream still runs.
    const guard = (fn: () => void) => {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      fn();
    };
    void streamSupportChat(
      payload,
      {
        onDelta: (text) =>
          guard(() =>
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, text: message.text + text }
                  : message,
              ),
            ),
          ),
        onDone: () =>
          guard(() => {
            patch({ status: "done" });
            setIsStreaming(false);
            streamingIdRef.current = null;
          }),
        onError: (message, retryable) =>
          guard(() => {
            patch({ status: "error", text: message, retryable });
            setIsStreaming(false);
            streamingIdRef.current = null;
          }),
      },
      { signal: controller.signal },
    );
  };

  const send = (raw: string) => {
    const text = raw.trim();
    if (!text || isStreaming) return;
    Haptics.selectionAsync();
    setDraft("");
    const userMessage: SupportMessage = {
      id: ++idRef.current,
      role: "user",
      text,
      status: "done",
    };
    const assistantId = ++idRef.current;
    const history = [...messagesRef.current, userMessage];
    setMessages([
      ...history,
      { id: assistantId, role: "assistant", text: "", status: "streaming" },
    ]);
    begin(history, assistantId);
  };

  const stop = () => {
    const streamingId = streamingIdRef.current;
    if (streamingId === null) return;
    Haptics.selectionAsync();
    abortRef.current?.abort();
    streamingIdRef.current = null;
    setIsStreaming(false);
    // Keep the partial text, flagged stopped — replayed turns tell the model
    // the reply was cut off so the next answer never continues it. Stopping
    // before any text arrived (mid "thinking") just removes the empty bubble:
    // the question stands unanswered, and no empty reply is ever replayed.
    setMessages((current) =>
      current.flatMap((message) => {
        if (message.id !== streamingId) return [message];
        if (message.text.trim().length === 0) return [];
        return [{ ...message, status: "done" as const, stopped: true }];
      }),
    );
  };

  const retry = (messageId: number) => {
    if (isStreaming) return;
    Haptics.selectionAsync();
    const index = messagesRef.current.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    const history = messagesRef.current.slice(0, index);
    setMessages([
      ...history,
      { id: messageId, role: "assistant", text: "", status: "streaming" },
    ]);
    begin(history, messageId);
  };

  const submitDraft = () => send(draft);

  if (!hydrated) return null;
  if (mode !== "staff" && !realAccount && pathname === "/support-chat") {
    return <Redirect href="/persona" />;
  }

  const latest = messages[messages.length - 1];

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
            testID="support-back"
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
              THINNR HQ
            </Text>
            <View style={styles.headerTitleRow}>
              <Text style={[styles.headerTitle, { color: colors.navy }]}>
                AI Support
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
            AI SUPPORT · PLEASE NOTE
          </Text>
          <Text style={[styles.disclosureBody, { color: colors.bodyText }]}>
            This assistant is AI. Answers come only from the knowledge
            documents THINNR HQ has uploaded. It can make mistakes, so confirm
            with HQ when something matters.
          </Text>
        </View>

        {messages.map((message) => (
          <SupportBubble
            key={message.id}
            message={message}
            isLatest={latest?.id === message.id}
            isStreaming={isStreaming}
            onRetry={retry}
          />
        ))}

        {hasUserMessage ? null : (
          <View style={styles.starterBlock}>
            <Text style={[styles.starterLabel, { color: colors.labelText }]}>
              TRY ASKING
            </Text>
            {SUGGESTED_QUESTIONS.map((question, index) => (
              <Pressable
                key={question}
                testID={`support-starter-${index}`}
                accessibilityRole="button"
                onPress={() => send(question)}
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
                  {question}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {keyboardHeight > 0 ? (
          <View
            // Reserve exactly the strip the risen composer + keyboard cover.
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
          <View style={styles.inputRow}>
            <TextInput
              testID="support-input"
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask about the THINNR program…"
              placeholderTextColor={colors.subtleText}
              editable={!isStreaming}
              maxLength={MAX_SUPPORT_QUESTION_LENGTH}
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
                testID="support-stop"
                accessibilityRole="button"
                accessibilityLabel="Stop response"
                onPress={stop}
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
                testID="support-send"
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

function SupportBubble({
  message,
  isLatest,
  isStreaming,
  onRetry,
}: {
  message: SupportMessage;
  isLatest: boolean;
  isStreaming: boolean;
  onRetry: (messageId: number) => void;
}) {
  const colors = useColors();

  if (message.role === "staff") {
    const sender = message.senderLabel?.trim() || "Your care team";
    return (
      <View
        accessible
        accessibilityLabel={`Care team message from ${sender}: ${message.text}`}
        style={[
          styles.bubble,
          styles.careTeamBubble,
          {
            backgroundColor: colors.paperCardAlt,
            borderColor: colors.navy,
            borderRadius: colors.radius,
          },
        ]}
      >
        <Text style={[styles.careTeamLabel, { color: colors.orangeText }]}>
          {message.senderLabel ? `From your care team · ${sender}` : sender}
        </Text>
        <Text style={[styles.bubbleText, { color: colors.navy }]}>{message.text}</Text>
      </View>
    );
  }

  if (message.role === "user") {
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
  const isThinking =
    message.status === "streaming" && message.text.trim().length === 0;
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
      ) : isError ? (
        <Text style={[styles.bubbleText, { color: colors.riskText }]}>
          {message.text}
        </Text>
      ) : (
        <SupportMarkdown text={message.text} />
      )}
      {message.stopped ? (
        <Text style={[styles.stoppedLabel, { color: colors.subtleText }]}>
          STOPPED
        </Text>
      ) : null}
      {isError && isLatest && !isStreaming && message.retryable !== false ? (
        <Pressable
          testID={`support-retry-${message.id}`}
          accessibilityRole="button"
          accessibilityLabel="Retry your question"
          onPress={() => onRetry(message.id)}
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

/** Same pattern as the coach chat: pin the input above the keyboard. */
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
    flex: 1,
    fontSize: 13.5,
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
    maxWidth: "92%",
  },
  careTeamBubble: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderLeftWidth: 3,
    maxWidth: "92%",
  },
  careTeamLabel: {
    fontSize: 9.5,
    letterSpacing: 0.7,
    fontFamily: "Inter_700Bold",
    marginBottom: 6,
    textTransform: "uppercase",
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
