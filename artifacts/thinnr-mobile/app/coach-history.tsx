import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
  AccessibilityInfo,
  Alert
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter, Link } from "expo-router";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { fonts } from "@/constants/colors";
import { useCoachChat } from "@/context/CoachChatContext";
import { usePatientAccount, type PatientAccountState } from "@/context/PatientAccountContext";
import { retryPatientCoachProcessing } from "@workspace/api-client-react";
import type { CoachConversation } from "@workspace/api-client-react";
import { ErrorBox } from "@/components/onboarding/OnboardingFields";
import { PageFlatList as FlatList } from "@/components/ui/PageScrollView";

export default function CoachHistoryScreen() {
  const accountState = usePatientAccount();
  const accountKey = accountState.account.kind === "real" ? accountState.account.patientId : accountState.account.kind;
  const accountEpochRef = useRef({ key: accountKey, value: 0 });
  if (accountEpochRef.current.key !== accountKey) {
    accountEpochRef.current = { key: accountKey, value: accountEpochRef.current.value + 1 };
  }

  return (
    <CoachHistoryContent
      key={`${accountKey}:${accountEpochRef.current.value}`}
      accountState={accountState}
      accountEpoch={accountEpochRef.current.value}
      accountEpochRef={accountEpochRef}
    />
  );
}

function CoachHistoryContent({
  accountState,
  accountEpoch,
  accountEpochRef,
}: {
  accountState: PatientAccountState;
  accountEpoch: number;
  accountEpochRef: React.MutableRefObject<{ key: string; value: number }>;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { startNewConversation, selectConversation, listConversations, setArchived, loadOlder } = useCoachChat();
  const { account, resolving, getAccessToken } = accountState;
  const accountKey = account.kind === "real" ? account.patientId : account.kind;
  const isCurrent = useCallback(
    () => accountEpochRef.current.value === accountEpoch && accountEpochRef.current.key === accountKey,
    [accountEpoch, accountEpochRef, accountKey],
  );

  const [archivedTab, setArchivedTab] = useState(false);
  const [conversations, setConversations] = useState<CoachConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingRowId, setLoadingRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const loadMoreLockRef = useRef(false);
  const archiveLockRef = useRef(new Set<string>());
  const retryLockRef = useRef(false);

  const load = useCallback(async () => {
    if (resolving || account.kind === "unresolved") return;
    const requestId = ++listRequestRef.current;
    const requestedArchived = archivedTab;
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    try {
      const page = await listConversations(requestedArchived, 0);
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setConversations(page.conversations);
      setNextOffset(page.nextOffset);
    } catch {
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setError("Failed to load conversations. Please try again.");
    } finally {
      if (isCurrent() && listRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [account.kind, archivedTab, isCurrent, listConversations, resolving]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const loadMore = async () => {
    if (loading || loadingMore || nextOffset === null || error || loadMoreLockRef.current) return;
    const requestId = ++listRequestRef.current;
    const requestedOffset = nextOffset;
    const requestedArchived = archivedTab;
    loadMoreLockRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await listConversations(requestedArchived, requestedOffset);
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setConversations(prev => {
        const existing = new Set(prev.map(c => c.id));
        const additions = page.conversations.filter(c => !existing.has(c.id));
        return [...prev, ...additions];
      });
      setNextOffset(page.nextOffset);
    } catch {
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setLoadMoreError("Couldn't load more conversations. Please try again.");
    } finally {
      loadMoreLockRef.current = false;
      if (isCurrent() && listRequestRef.current === requestId) {
        setLoadingMore(false);
      }
    }
  };

  const handleNewChat = () => {
    Haptics.selectionAsync();
    startNewConversation();
    router.push("/coach-chat");
  };

  const handleSelect = async (id: string) => {
    if (loadingRowId) return;
    Haptics.selectionAsync();
    setLoadingRowId(id);
    try {
      await selectConversation(id);
      if (!isCurrent()) return;
      router.push("/coach-chat");
    } catch {
      if (!isCurrent()) return;
      if (Platform.OS === 'web') {
        window.alert("Failed to open conversation. Please try again.");
      } else {
        Alert.alert("Error", "Failed to open conversation. Please try again.");
      }
    } finally {
      if (isCurrent()) {
        setLoadingRowId(null);
      }
    }
  };

  const handleToggleArchive = async (conversation: CoachConversation) => {
    if (archiveLockRef.current.has(conversation.id)) return;
    archiveLockRef.current.add(conversation.id);
    Haptics.selectionAsync();
    setArchivingId(conversation.id);
    try {
      await setArchived(conversation, !archivedTab);
      if (!isCurrent()) return;
      setConversations(prev => prev.filter(c => c.id !== conversation.id));
      if (Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(`Conversation ${!archivedTab ? 'archived' : 'restored'}`);
      }
    } catch {
      if (!isCurrent()) return;
      if (Platform.OS === 'web') {
        window.alert("Failed to change archive state. Please try again.");
      } else {
        Alert.alert("Error", "Failed to change archive state. Please try again.");
      }
    } finally {
      archiveLockRef.current.delete(conversation.id);
      if (isCurrent()) setArchivingId(null);
    }
  };

  const handleRetryProcessing = async (id: string) => {
    if (retryLockRef.current || account.kind !== "real") return;
    retryLockRef.current = true;
    Haptics.selectionAsync();
    setRetryingId(id);
    try {
      // Resolve once before the generated client starts; its global getter can
      // otherwise pick up a different account while this request is in flight.
      const token = await getAccessToken?.();
      if (!token) throw new Error("Authentication is unavailable.");
      if (!isCurrent()) return;
      await retryPatientCoachProcessing(id, { headers: { Authorization: `Bearer ${token}` } });
      if (isCurrent()) void load();
    } catch {
      if (isCurrent()) {
        if (Platform.OS === "web") window.alert("Failed to retry processing. Please try again.");
        else Alert.alert("Error", "Failed to retry processing. Please try again.");
      }
    } finally {
      retryLockRef.current = false;
      if (isCurrent()) setRetryingId(null);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  };

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.headerBand, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: topPad }]}>
        <View style={styles.headerRow}>
          <Pressable
            testID="history-back"
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={() => {
              Haptics.selectionAsync();
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace("/");
              }
            }}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
              pressed && { backgroundColor: colors.accent }
            ]}
          >
            <Feather name="chevron-left" size={18} color={colors.navy} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerTitle, { color: colors.navy }]}>Chat History</Text>
          </View>
          <Pressable
            testID="history-new-chat"
            accessibilityRole="button"
            accessibilityLabel="Start new chat"
            onPress={handleNewChat}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
              pressed && { backgroundColor: colors.accent }
            ]}
          >
            <Feather name="edit" size={16} color={colors.cobalt} />
          </Pressable>
        </View>
        <View style={styles.tabsRow} accessibilityRole="tablist">
          <Pressable
            testID="tab-active"
            accessibilityRole="tab"
            accessibilityState={{ selected: !archivedTab }}
            aria-selected={!archivedTab}
            onPress={() => {
              if (archivedTab) {
                Haptics.selectionAsync();
                setArchivedTab(false);
              }
            }}
            style={[styles.tab, !archivedTab && { borderBottomColor: colors.cobalt }]}
          >
            <Text style={[styles.tabText, { color: !archivedTab ? colors.cobalt : colors.subtleText }]}>Active</Text>
          </Pressable>
          <Pressable
            testID="tab-archived"
            accessibilityRole="tab"
            accessibilityState={{ selected: archivedTab }}
            aria-selected={archivedTab}
            onPress={() => {
              if (!archivedTab) {
                Haptics.selectionAsync();
                setArchivedTab(true);
              }
            }}
            style={[styles.tab, archivedTab && { borderBottomColor: colors.cobalt }]}
          >
            <Text style={[styles.tabText, { color: archivedTab ? colors.cobalt : colors.subtleText }]}>Archived</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.memoriesLinkContainer, { borderBottomColor: colors.border }]}>
        <Link href={({ pathname: "/coach-memories" }) as any} asChild>
          <Pressable 
            accessibilityRole="link" 
            accessibilityLabel="View what the coach remembers"
            style={({ pressed }) => [
              styles.memoriesLink, 
              pressed && { backgroundColor: colors.accent }
            ]}
          >
            <Feather name="database" size={16} color={colors.cobalt} style={{ marginRight: 8 }} />
            <Text style={[styles.memoriesLinkText, { color: colors.cobalt }]}>What the coach remembers</Text>
            <Feather name="chevron-right" size={16} color={colors.cobalt} />
          </Pressable>
        </Link>
      </View>

      {error ? (
        <View style={styles.errorState} accessibilityRole="alert">
          <ErrorBox testID="history-error" message={error} />
          <Pressable
            testID="history-retry"
            accessibilityRole="button"
            onPress={load}
            style={({ pressed }) => [
              styles.emptyBtn,
              { backgroundColor: colors.cobalt, borderRadius: colors.radius },
              pressed && { opacity: 0.9 }
            ]}
          >
            <Text style={styles.emptyBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.cobalt} />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.emptyState}>
          <Feather name="message-square" size={32} color={colors.mutedForeground} style={styles.emptyIcon} />
          <Text style={[styles.emptyTitle, { color: colors.navy }]}>
            {archivedTab ? "No archived conversations" : "No active conversations"}
          </Text>
          <Text style={[styles.emptyBody, { color: colors.bodyText }]}>
            {archivedTab ? "Conversations you archive will appear here." : "Start a new chat to talk with your AI Coach."}
          </Text>
          {!archivedTab && (
            <Pressable
              onPress={handleNewChat}
              style={({ pressed }) => [
                styles.emptyBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radius },
                pressed && { opacity: 0.9 }
              ]}
            >
              <Text style={styles.emptyBtnText}>Start New Chat</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={colors.subtleText} />
              </View>
            ) : loadMoreError ? (
               <View style={styles.footerLoader}>
                 <ErrorBox testID="history-load-more-error" message={loadMoreError} />
                 <Pressable testID="history-load-more-retry" accessibilityRole="button" onPress={loadMore}>
                    <Text style={{ color: colors.cobalt, fontFamily: fonts.sansMedium }}>Retry load more</Text>
                 </Pressable>
               </View>
            ) : nextOffset !== null ? (
               <Pressable testID="history-load-more" accessibilityRole="button" onPress={loadMore} style={styles.footerLoader}>
                  <Text style={{ color: colors.cobalt, fontFamily: fonts.sansMedium }}>Load more...</Text>
               </Pressable>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={[styles.rowContainer, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open conversation: ${item.title}`}
                onPress={() => handleSelect(item.id)}
                style={({ pressed }) => [
                  styles.rowPressable,
                  pressed && { backgroundColor: colors.accent }
                ]}
              >
                <View style={styles.rowMain}>
                  <Text style={[styles.rowTitle, { color: colors.navy }]} numberOfLines={1}>
                    {item.title || "New conversation"}
                  </Text>
                  <Text style={[styles.rowDate, { color: colors.subtleText }]}>
                    {formatDate(item.updatedAt)}
                  </Text>
                </View>
                {item.processingState === 'failed' && (
                  <View style={[styles.failedBadge, { backgroundColor: colors.riskBg, borderColor: colors.riskBorder }]}>
                    <Text style={[styles.failedBadgeText, { color: colors.riskText }]}>Failed</Text>
                  </View>
                )}
                {loadingRowId === item.id ? (
                  <ActivityIndicator size="small" color={colors.subtleText} style={styles.rowChevron} />
                ) : (
                  <Feather name="chevron-right" size={18} color={colors.subtleText} style={styles.rowChevron} />
                )}
              </Pressable>
              
              {item.processingState === 'failed' && (
                <View style={[styles.retryProcessingBlock, { backgroundColor: colors.riskBg }]}>
                   <Text style={[styles.retryProcessingText, { color: colors.riskText }]}>Processing failed. Title and memories might be missing.</Text>
                   <Pressable 
                     onPress={() => handleRetryProcessing(item.id)}
                      disabled={retryingId !== null}
                     style={({ pressed }) => [
                       styles.retryProcessingBtn,
                       { backgroundColor: colors.card, borderColor: colors.riskBorder },
                        (pressed || retryingId !== null) && { opacity: 0.7 }
                     ]}
                   >
                      {retryingId === item.id ? (
                       <ActivityIndicator size="small" color={colors.riskText} />
                     ) : (
                       <Text style={[styles.retryProcessingBtnText, { color: colors.riskText }]}>Retry Processing</Text>
                     )}
                   </Pressable>
                </View>
              )}

              <View style={[styles.rowActions, { borderTopColor: colors.border }]}>
                <View style={styles.actionInfo}>
                   <Text style={[styles.actionInfoText, { color: colors.subtleText }]}>
                     {archivedTab ? "Archived chats are hidden." : "Archive to hide. Coach still remembers."}
                   </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={archivedTab ? "Restore conversation" : "Archive conversation"}
                  onPress={() => handleToggleArchive(item)}
                  disabled={archivingId === item.id}
                  style={({ pressed }) => [
                    styles.actionBtn,
                    pressed && { backgroundColor: colors.accent }
                  ]}
                >
                  {archivingId === item.id ? <ActivityIndicator size="small" color={colors.subtleText} /> : <Feather name={archivedTab ? "rotate-ccw" : "archive"} size={14} color={colors.subtleText} />}
                  <Text style={[styles.actionBtnText, { color: colors.subtleText }]}>
                    {archivedTab ? "Restore" : "Archive"}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}
    </View>
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
    paddingBottom: 16,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
  },
  headerTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 18,
  },
  tabsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  memoriesLinkContainer: {
    borderBottomWidth: 1,
  },
  memoriesLink: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  memoriesLinkText: {
    flex: 1,
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  errorState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  emptyIcon: {
    marginBottom: 16,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    marginBottom: 8,
    textAlign: "center",
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  emptyBtnText: {
    color: "#fff",
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  rowContainer: {
    borderWidth: 1,
    overflow: "hidden",
  },
  rowPressable: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 16,
    marginBottom: 4,
  },
  rowDate: {
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  failedBadge: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  failedBadgeText: {
    fontFamily: fonts.sansMedium,
    fontSize: 10,
    textTransform: "uppercase",
  },
  rowChevron: {
    marginLeft: 12,
  },
  retryProcessingBlock: {
    padding: 12,
    paddingHorizontal: 16,
  },
  retryProcessingText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    marginBottom: 8,
  },
  retryProcessingBtn: {
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignSelf: "flex-start",
  },
  retryProcessingBtnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
  },
  rowActions: {
    flexDirection: "row",
    borderTopWidth: 1,
    alignItems: "center",
  },
  actionInfo: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  actionInfoText: {
    fontFamily: fonts.sans,
    fontSize: 12,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(0,0,0,0.05)",
  },
  actionBtnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
  },
  footerLoader: {
    paddingVertical: 16,
    alignItems: "center",
  }
});
