import React, { useEffect, useRef, useState } from "react";
import {
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
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useCareTeamChat } from "@/context/CareTeamChatContext";
import {
  CareTeamBundleCard,
  CareTeamProductCard,
} from "@/components/care-team/ProductSuggestionCards";

const BUBBLE_SHADOW = "0 5px 12px rgba(35, 61, 95, 0.07)";
const CARD_SHADOW = "0 8px 20px rgba(40, 55, 74, 0.07)";

export default function CareTeamChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ conversationId?: string | string[] }>();
  const {
    messages,
    loading,
    loadingOlder,
    hasOlder,
    error,
    draft,
    setDraft,
    sendMessage,
    retryMessage,
    markRead,
    loadOlder,
    pendingMessages,
    currentConversation,
    retainedConversations,
    selectedConversation,
    selectConversation,
    setScreenFocused,
  } = useCareTeamChat();
  const [focused, setFocused] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const nearBottomRef = useRef(true);
  const tailSeqRef = useRef(0);
  const pendingCountRef = useRef(0);
  const conversationIdRef = useRef<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const requestedConversationId = Array.isArray(params.conversationId)
    ? params.conversationId[0]
    : params.conversationId;

  useFocusEffect(
    React.useCallback(() => {
      setFocused(true);
      setScreenFocused(true);
      return () => {
        setFocused(false);
        setScreenFocused(false);
      };
    }, [setScreenFocused]),
  );

  useEffect(() => {
    if (!requestedConversationId) return;
    const intended = currentConversation?.id === requestedConversationId
      ? currentConversation
      : retainedConversations.find(conversation => conversation.id === requestedConversationId);
    if (intended && selectedConversation?.id !== intended.id) selectConversation(intended);
  }, [
    currentConversation,
    requestedConversationId,
    retainedConversations,
    selectConversation,
    selectedConversation?.id,
  ]);

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top;

  useEffect(() => {
    const tailSeq = messages[messages.length - 1]?.seq ?? 0;
    const pendingCount = Object.keys(pendingMessages).length;
    const selectionChanged = conversationIdRef.current !== (selectedConversation?.id ?? null);
    const appendedAtTail = tailSeq > tailSeqRef.current || pendingCount > pendingCountRef.current;
    tailSeqRef.current = tailSeq;
    pendingCountRef.current = pendingCount;
    conversationIdRef.current = selectedConversation?.id ?? null;
    if (selectionChanged || appendedAtTail) nearBottomRef.current = true;
    if (!selectionChanged && !appendedAtTail) return;
    if (!nearBottomRef.current) return;
    
    scrollRef.current?.scrollToEnd({ animated: false });
    const timer = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      40,
    );
    return () => clearTimeout(timer);
  }, [messages, pendingMessages, selectedConversation?.id]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const setFrom = (event: { height: number }) => setKeyboardHeight(event.height);
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

  useEffect(() => {
    if (messages.length > 0) {
      const lastSeq = messages[messages.length - 1].seq;
      if (focused && selectedConversation?.current && lastSeq > selectedConversation.lastReadSeq) {
        markRead(lastSeq);
      }
    }
  }, [focused, messages, selectedConversation, markRead]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || !selectedConversation?.canSend) return;
    Haptics.selectionAsync();
    setDraft("");
    sendMessage(text);
  };

  const businessName = selectedConversation?.businessName || currentConversation?.businessName || "Your Care Team";

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
            testID="care-team-back"
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
              {businessName.toUpperCase()}
            </Text>
            <View style={styles.headerTitleRow}>
              <Text style={[styles.headerTitle, { color: colors.navy }]}>
                Care Team
              </Text>
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
            CARE TEAM MESSAGING
          </Text>
          <Text style={[styles.disclosureBody, { color: colors.bodyText }]}>
            This chat connects you directly with your provider’s office. Authorized office staff and permitted THINNR administrators may review these messages to coordinate your care.
          </Text>
        </View>

        {retainedConversations.length > 0 || (currentConversation && selectedConversation?.id !== currentConversation.id) ? (
          <View
            accessibilityRole="tablist"
            accessibilityLabel="Care team conversation history"
            style={styles.threadPicker}
          >
            {currentConversation ? (
              <Pressable
                testID="care-team-thread-current"
                accessibilityRole="tab"
                accessibilityState={{ selected: selectedConversation?.id === currentConversation.id }}
                accessibilityLabel={`Current office, ${currentConversation.businessName}`}
                onPress={() => selectConversation(currentConversation)}
                style={[
                  styles.threadChip,
                  { borderColor: colors.border, backgroundColor: selectedConversation?.id === currentConversation.id ? colors.accent : colors.card },
                ]}
              >
                <Text style={[styles.threadChipText, { color: colors.navy }]}>CURRENT OFFICE</Text>
              </Pressable>
            ) : null}
            {retainedConversations.map(conversation => (
              <Pressable
                key={conversation.id}
                testID={`care-team-thread-${conversation.id}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: selectedConversation?.id === conversation.id }}
                accessibilityLabel={`Previous office, ${conversation.businessName}, read only`}
                onPress={() => selectConversation(conversation)}
                style={[
                  styles.threadChip,
                  { borderColor: colors.border, backgroundColor: selectedConversation?.id === conversation.id ? colors.accent : colors.card },
                ]}
              >
                <Text style={[styles.threadChipText, { color: colors.navy }]} numberOfLines={1}>
                  {conversation.businessName.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {selectedConversation && !selectedConversation.current ? (
          <View
            testID="care-team-retained-notice"
            accessibilityRole="summary"
            style={[styles.noticeBox, { borderColor: colors.warnBorder, backgroundColor: colors.warnBg }]}
          >
            <Feather name="archive" size={14} color={colors.warnText} />
            <Text style={[styles.noticeText, { color: colors.warnText }]}>
              Previous office conversation — retained for your records and read only.
            </Text>
          </View>
        ) : null}

        {hasOlder ? (
          <Pressable
            testID="care-team-load-older"
            accessibilityRole="button"
            accessibilityLabel={loadingOlder ? "Loading earlier messages" : "Load earlier messages"}
            disabled={loadingOlder}
            onPress={() => void loadOlder()}
            style={[styles.olderButton, { borderColor: colors.border, backgroundColor: colors.card }]}
          >
            {loadingOlder ? <ActivityIndicator size="small" color={colors.cobalt} /> : <Feather name="chevron-up" size={14} color={colors.cobalt} />}
            <Text style={[styles.olderText, { color: colors.cobalt }]}>
              {loadingOlder ? "LOADING…" : "LOAD EARLIER MESSAGES"}
            </Text>
          </Pressable>
        ) : null}

        {loading && messages.length === 0 ? (
          <View testID="care-team-loading" accessibilityRole="progressbar" style={styles.stateBox}>
            <ActivityIndicator color={colors.cobalt} />
            <Text style={[styles.stateText, { color: colors.bodyText }]}>Loading your private care team conversation…</Text>
          </View>
        ) : null}

        {!loading && selectedConversation && messages.length === 0 ? (
          <View testID="care-team-empty" style={styles.stateBox}>
            <Feather name="message-circle" size={20} color={colors.cobalt} />
            <Text style={[styles.stateText, { color: colors.bodyText }]}>
              {selectedConversation.canSend
                ? "No messages yet. Send a message to start the conversation with your care team."
                : "No messages here yet."}
            </Text>
          </View>
        ) : null}

        {messages.map((message) => {
          const isUser = message.sender === 'patient';
          const timeString = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const unread = !isUser && currentConversation && message.seq > currentConversation.lastReadSeq;

          return (
            <View key={message.clientId} style={[styles.bubbleWrapper, isUser ? styles.userWrapper : styles.staffWrapper]}>
              <View
                style={[
                  styles.bubble,
                  isUser ? styles.userBubble : styles.staffBubble,
                  {
                    backgroundColor: isUser ? colors.cobalt : colors.card,
                    borderColor: isUser ? colors.cobalt : colors.border,
                    borderRadius: colors.radius,
                    borderBottomRightRadius: isUser ? 3 : colors.radius,
                    borderBottomLeftRadius: isUser ? colors.radius : 3,
                    boxShadow: !isUser ? BUBBLE_SHADOW : undefined,
                  },
                  !isUser && { borderLeftWidth: 3, borderLeftColor: colors.navy }
                ]}
              >
                {!isUser ? (
                  <Text style={[styles.senderLabel, { color: colors.orangeText }]}>
                    FROM YOUR CARE TEAM
                  </Text>
                ) : null}
                <Text style={[styles.bubbleText, { color: isUser ? colors.primaryForeground : colors.navy }]}>
                  {message.text}
                </Text>
              </View>
              {!isUser && message.suggestion?.mode === "individual"
                ? message.suggestion.items.map((item) => (
                    <CareTeamProductCard
                      key={`${item.productId}:${item.purchase}`}
                      item={item}
                    />
                  ))
                : null}
              {!isUser && message.suggestion?.mode === "bundle" ? (
                <CareTeamBundleCard
                  suggestion={message.suggestion}
                  clientId={message.clientId}
                />
              ) : null}
              <View style={[styles.metaRow, isUser ? styles.metaRowUser : styles.metaRowStaff]}>
                <Text style={[styles.timeText, { color: colors.subtleText }]}>{timeString}</Text>
                {unread ? <View style={[styles.unreadDot, { backgroundColor: colors.cobalt }]} /> : null}
              </View>
            </View>
          );
        })}

        {Object.entries(pendingMessages).map(([clientId, pending]) => {
          const isFailed = pending.status === 'failed';
          return (
            <View key={clientId} style={[styles.bubbleWrapper, styles.userWrapper]}>
              <View
                style={[
                  styles.bubble,
                  styles.userBubble,
                  {
                    backgroundColor: isFailed ? colors.riskBg : colors.cobalt,
                    borderColor: isFailed ? colors.riskBorder : colors.cobalt,
                    borderRadius: colors.radius,
                    borderBottomRightRadius: 3,
                  },
                  !isFailed && { opacity: 0.7 }
                ]}
              >
                <Text style={[styles.bubbleText, { color: isFailed ? colors.riskText : colors.primaryForeground }]}>
                  {pending.text}
                </Text>
                {isFailed && selectedConversation?.canSend ? (
                  <Pressable
                    testID={`care-team-retry-${clientId}`}
                    onPress={() => retryMessage(clientId)}
                    style={styles.retryBtn}
                  >
                    <Feather name="refresh-cw" size={11} color={colors.riskText} />
                    <Text style={[styles.retryText, { color: colors.riskText }]}>RETRY</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={[styles.timeText, { color: colors.subtleText, marginTop: 4 }]}>
                {isFailed ? 'Failed to send' : 'Sending...'}
              </Text>
            </View>
          );
        })}

        {keyboardHeight > 0 ? (
          <View
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
          {error ? (
            <View
              testID="care-team-error"
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[
                styles.errorBox,
                {
                  backgroundColor: colors.riskBg,
                  borderColor: colors.riskBorder,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Feather name="alert-triangle" size={13} color={colors.riskText} style={styles.errorIcon} />
              <Text style={[styles.errorText, { color: colors.riskText }]}>{error}</Text>
            </View>
          ) : null}
          {!selectedConversation?.canSend && selectedConversation ? (
            <View
              style={[
                styles.errorBox,
                {
                  backgroundColor: colors.warnBg,
                  borderColor: colors.warnBorder,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Feather name="info" size={13} color={colors.warnText} style={styles.errorIcon} />
               <Text testID="care-team-read-only-notice" style={[styles.errorText, { color: colors.warnText }]}>
                 {selectedConversation.readOnlyNotice
                   ? selectedConversation.readOnlyNotice
                   : selectedConversation.current
                     ? "This conversation is closed for new messages."
                     : "Previous-office conversations are read only."}
               </Text>
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <TextInput
              testID="care-team-composer"
              value={draft}
              onChangeText={setDraft}
              placeholder={selectedConversation?.canSend === false ? "Conversation read only" : "Message your care team"}
              placeholderTextColor={colors.subtleText}
              editable={!!selectedConversation?.canSend && !loading}
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
            <Pressable
              testID="care-team-send"
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={draft.trim().length === 0 || !selectedConversation?.canSend || loading}
              onPress={submitDraft}
              style={({ pressed }) => [
                styles.sendBtn,
                {
                  backgroundColor:
                    draft.trim().length === 0 || !selectedConversation?.canSend || loading
                      ? colors.cobaltMuted
                      : colors.cobalt,
                  borderRadius: colors.radiusSm,
                },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Feather name="arrow-up" size={18} color={colors.primaryForeground} />
            </Pressable>
          </View>
        </View>
      </InputAboveKeyboard>
    </View>
  );
}

function InputAboveKeyboard({ bottomInset, children }: { bottomInset: number; children: React.ReactNode }) {
  if (Platform.OS === "web") return <>{children}</>;
  return <KeyboardStickyView offset={{ closed: 0, opened: bottomInset }}>{children}</KeyboardStickyView>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBand: { borderBottomWidth: 1 },
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
  backBtn: { width: 44, height: 44, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  backBtnSpacer: { width: 44 },
  headerCenter: { alignItems: "center" },
  headerLabel: { fontSize: 9, fontWeight: "700", letterSpacing: 1.4, fontFamily: "Inter_700Bold" },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  headerTitle: { fontSize: 18, fontFamily: "PlayfairDisplay_700Bold", letterSpacing: 0.2 },
  scroll: { flex: 1 },
  thread: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
    gap: 16,
  },
  disclosureCard: { borderWidth: 1, padding: 14, marginBottom: 6 },
  disclosureLabel: { fontSize: 9, fontWeight: "700", letterSpacing: 1.4, fontFamily: "Inter_700Bold", marginBottom: 6 },
  disclosureBody: { fontSize: 12.5, lineHeight: 18, fontFamily: "Inter_400Regular" },
  threadPicker: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  threadChip: { maxWidth: "100%", borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  threadChipText: { maxWidth: 240, fontSize: 9.5, letterSpacing: 0.7, fontFamily: "Inter_700Bold" },
  noticeBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, padding: 11 },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17, fontFamily: "Inter_500Medium" },
  olderButton: { alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9 },
  olderText: { fontSize: 9.5, letterSpacing: 0.8, fontFamily: "Inter_700Bold" },
  stateBox: { alignItems: "center", gap: 10, paddingVertical: 24, paddingHorizontal: 20 },
  stateText: { textAlign: "center", fontSize: 13, lineHeight: 19, fontFamily: "Inter_400Regular" },
  bubbleWrapper: { maxWidth: "90%", width: "100%" },
  userWrapper: { alignSelf: "flex-end" },
  staffWrapper: { alignSelf: "flex-start" },
  bubble: {
    paddingVertical: 10,
    paddingHorizontal: 13,
    borderWidth: 1,
  },
  userBubble: {},
  staffBubble: { borderLeftWidth: 3 },
  senderLabel: { fontSize: 9.5, letterSpacing: 0.7, fontFamily: "Inter_700Bold", marginBottom: 6 },
  bubbleText: { fontSize: 14.5, lineHeight: 21, fontFamily: "Inter_400Regular" },
  metaRow: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 4 },
  metaRowUser: { justifyContent: "flex-end" },
  metaRowStaff: { justifyContent: "flex-start" },
  timeText: { fontSize: 10, fontFamily: "Inter_500Medium" },
  unreadDot: { width: 6, height: 6, borderRadius: 3 },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 9,
    alignSelf: "flex-start",
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  retryText: { fontSize: 9.5, fontWeight: "700", letterSpacing: 1.1, fontFamily: "Inter_700Bold" },
  inputBar: {
    gap: 10,
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  input: { flex: 1, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 12, fontSize: 15, fontFamily: "Inter_400Regular" },
  sendBtn: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  errorBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, padding: 10 },
  errorIcon: { marginTop: 2 },
  errorText: { flex: 1, fontSize: 12.5, lineHeight: 18, fontFamily: "Inter_400Regular" },
});