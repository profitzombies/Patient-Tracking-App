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
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { fonts } from "@/constants/colors";
import { useCoachChat } from "@/context/CoachChatContext";
import { usePatientAccount, type PatientAccountState } from "@/context/PatientAccountContext";
import { retryPatientCoachProcessing } from "@workspace/api-client-react";
import type { CoachConversation } from "@workspace/api-client-react";
import { ErrorBox } from "@/components/onboarding/OnboardingFields";
import { CoachHistorySkeleton } from "@/components/coach/CoachHistorySkeleton";
import { PageFlatList as FlatList } from "@/components/ui/PageScrollView";

export default function CoachHistoryScreen() {
  const accountState = usePatientAccount();
  const { historyScopeKey } = useCoachChat();
  const accountKey = historyScopeKey ?? (accountState.resolving ? "resolving" : accountState.account.kind === "real" ? accountState.account.patientId : accountState.account.kind);
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
  const { startNewConversation, selectConversation, listConversations, getCachedConversations, historyScopeKey, setArchived, accessDeniedError } = useCoachChat();
  const { account, resolving, getAccessToken } = accountState;
  const accountKey = historyScopeKey ?? (resolving ? "resolving" : account.kind === "real" ? account.patientId : account.kind);
  const isCurrent = useCallback(
    () => accountEpochRef.current.value === accountEpoch && accountEpochRef.current.key === accountKey,
    [accountEpoch, accountEpochRef, accountKey],
  );

  const [archivedTab, setArchivedTab] = useState(false);
  const cachedPage = getCachedConversations?.(false);
  const [storedConversations, setConversations] = useState<CoachConversation[]>(() => cachedPage?.conversations ?? []);
  const conversations = accessDeniedError ? [] : storedConversations;
  const [known, setKnown] = useState(() => cachedPage !== undefined);
  const [loading, setLoading] = useState(() => cachedPage === undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(() => cachedPage?.nextOffset ?? null);
  const [loadError, setError] = useState<string | null>(null);
  const error = accessDeniedError ?? loadError;
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const loadMoreLockRef = useRef(false);
  const archiveLockRef = useRef(new Set<string>());
  const retryLockRef = useRef(false);
  const archivedTabRef = useRef(false);
  archivedTabRef.current = archivedTab;
  const initialLoading = !known && loading && !error;

  useEffect(() => {
    if (!accessDeniedError) return;
    listRequestRef.current += 1;
    loadMoreLockRef.current = false;
    setConversations([]);
    setNextOffset(null);
    setKnown(false);
    setLoading(false);
    setLoadingMore(false);
    setLoadMoreError(null);
  }, [accessDeniedError]);

  useEffect(() => {
    if (initialLoading && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility("Loading chat history");
    }
  }, [initialLoading]);

  const load = useCallback(async (force = false) => {
    if (resolving || account.kind === "unresolved") return;
    if (accessDeniedError && !force) return;
    const requestId = ++listRequestRef.current;
    const requestedArchived = archivedTab;
    // A focus refresh supersedes an older-page request. Retire its UI lock
    // as well as its request generation so a late finally cannot pin the footer.
    loadMoreLockRef.current = false;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    try {
      const page = await listConversations(requestedArchived, 0, force);
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setConversations(page.conversations);
      setNextOffset(page.nextOffset);
      setKnown(true);
    } catch (cause) {
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      if ((cause as { code?: string })?.code === "COACH_READ_STALE") return;
      const status = (cause as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 404) {
        setConversations([]);
        setNextOffset(null);
        setKnown(false);
        setError("Conversation access is unavailable. Check your account and try again.");
      } else {
        setError("Couldn't refresh conversations. Check your connection and try again.");
      }
    } finally {
      if (isCurrent() && listRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [account.kind, archivedTab, isCurrent, listConversations, resolving, accessDeniedError]);

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
    } catch (cause) {
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      if ((cause as { code?: string })?.code === "COACH_READ_STALE") return;
      const status = (cause as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 404) {
        setConversations([]);
        setNextOffset(null);
        setKnown(false);
        setError("Conversation access is unavailable. Check your account and try again.");
      } else {
        setLoadMoreError("Couldn't load more conversations. Please try again.");
      }
    } finally {
      loadMoreLockRef.current = false;
      if (isCurrent() && listRequestRef.current === requestId) {
        setLoadingMore(false);
      }
    }
  };

  const handleNewChat = () => {
    if (resolving || account.kind === "unresolved" || accessDeniedError) return;
    Haptics.selectionAsync();
    startNewConversation();
    router.push("/coach-chat");
  };

  const handleTabChange = (nextArchived: boolean) => {
    if (archivedTab === nextArchived) return;
    // Do not leave rows from the previous tab tappable while its replacement
    // page is in flight. Invalidate held requests before clearing old rows so
    // late responses cannot paint them back into the new tab.
    listRequestRef.current += 1;
    loadMoreLockRef.current = false;
    const cached = getCachedConversations?.(nextArchived);
    setConversations(cached?.conversations ?? []);
    setNextOffset(cached?.nextOffset ?? null);
    setKnown(cached !== undefined);
    setLoadingMore(false);
    setLoadMoreError(null);
    setError(null);
    setLoading(cached === undefined);
    Haptics.selectionAsync();
    setArchivedTab(nextArchived);
  };

  const handleSelect = (id: string) => {
    if (resolving || account.kind === "unresolved" || accessDeniedError || !isCurrent()) return;
    Haptics.selectionAsync();
    // Selection publishes its account/thread identity synchronously. Open the
    // destination now; its transcript region owns loading and retry, not this row.
    void selectConversation(id).catch(() => {});
    router.push("/coach-chat");
  };

  const handleToggleArchive = async (conversation: CoachConversation) => {
    if (archiveLockRef.current.has(conversation.id)) return;
    const requestedArchived = archivedTabRef.current;
    archiveLockRef.current.add(conversation.id);
    Haptics.selectionAsync();
    setArchivingId(conversation.id);
    try {
      await setArchived(conversation, !requestedArchived);
      if (!isCurrent()) return;
      setConversations(prev => prev.filter(c => c.id !== conversation.id));
      if (Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(`Conversation ${!requestedArchived ? 'archived' : 'restored'}`);
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
            onPress={() => handleTabChange(false)}
            style={[styles.tab, !archivedTab && { borderBottomColor: colors.cobalt }]}
          >
            <Text style={[styles.tabText, { color: !archivedTab ? colors.cobalt : colors.subtleText }]}>Active</Text>
          </Pressable>
          <Pressable
            testID="tab-archived"
            accessibilityRole="tab"
            accessibilityState={{ selected: archivedTab }}
            aria-selected={archivedTab}
            onPress={() => handleTabChange(true)}
            style={[styles.tab, archivedTab && { borderBottomColor: colors.cobalt }]}
          >
            <Text style={[styles.tabText, { color: archivedTab ? colors.cobalt : colors.subtleText }]}>Archived</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.memoriesLinkContainer, { borderBottomColor: colors.border }]}>
        <Pressable
          testID="history-memories"
          accessibilityRole="link"
          accessibilityLabel="View what the coach remembers"
          onPress={() => {
            Haptics.selectionAsync();
            router.push("/coach-memories");
          }}
          style={({ pressed }) => [
            styles.memoriesLink,
            pressed && { backgroundColor: colors.accent }
          ]}
        >
          <Feather name="database" size={16} color={colors.cobalt} style={{ marginRight: 8 }} />
          <Text style={[styles.memoriesLinkText, { color: colors.cobalt }]}>What the coach remembers</Text>
          <Feather name="chevron-right" size={16} color={colors.cobalt} />
        </Pressable>
      </View>

      {known && (loading || error) && (!error || conversations.length > 0) ? (
        <View testID="history-refresh-status" style={{ padding: 12, gap: 8 }}>
          <Text accessibilityLiveRegion="polite" style={{ color: colors.subtleText, fontFamily: fonts.sans }}>
            {error ? "Showing saved history. It may be out of date." : "Refreshing history…"}
          </Text>
          {error ? (
            <>
              <ErrorBox message={error} />
              <Pressable testID="history-refresh-retry" accessibilityRole="button" onPress={() => void load(true)}>
                <Text style={{ color: colors.cobalt, fontFamily: fonts.sansMedium }}>Retry</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
      {error && conversations.length === 0 ? (
        <View testID="history-error-state" style={styles.errorState} accessibilityRole="alert">
          <View style={styles.stateContent}>
            <View style={styles.errorMessage}>
              <ErrorBox testID="history-error" message={error} />
            </View>
            <Pressable
              testID="history-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry loading conversations"
              onPress={() => void load(true)}
              style={({ pressed }) => [
                styles.emptyBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radius },
                pressed && { opacity: 0.9 }
              ]}
            >
              <Text style={styles.emptyBtnText}>Retry</Text>
            </Pressable>
          </View>
        </View>
      ) : initialLoading ? (
        <CoachHistorySkeleton
          backgroundColor={colors.card}
          borderColor={colors.border}
          placeholderColor={colors.track}
          radius={colors.radius}
        />
       ) : known && conversations.length === 0 ? (
        <View testID="history-empty-state" style={styles.emptyState}>
          <View style={styles.stateContent}>
            <Feather name={archivedTab ? "archive" : "message-square"} size={32} color={colors.mutedForeground} style={styles.emptyIcon} />
            <Text style={[styles.emptyTitle, { color: colors.navy }]}>
              {archivedTab ? "No archived conversations" : "No active conversations yet"}
            </Text>
            <Text style={[styles.emptyBody, { color: colors.bodyText }]}>
              {archivedTab
                ? "Conversations you archive will appear here. Your active chats are still available on the Active tab."
                : "Start a new conversation with your AI Coach to see it here."}
            </Text>
            <View style={styles.emptyActions}>
              {archivedTab && (
                <Pressable
                  testID="history-view-active"
                  accessibilityRole="button"
                  accessibilityLabel="View active conversations"
                  onPress={() => handleTabChange(false)}
                  style={({ pressed }) => [
                    styles.emptyBtn,
                    styles.emptyBtnSecondary,
                    { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius },
                    pressed && { backgroundColor: colors.accent }
                  ]}
                >
                  <Text style={[styles.emptyBtnSecondaryText, { color: colors.cobalt }]}>View active conversations</Text>
                </Pressable>
              )}
              <Pressable
                testID="history-empty-new-chat"
                accessibilityRole="button"
                accessibilityLabel="Start a new conversation"
                onPress={handleNewChat}
                style={({ pressed }) => [
                  styles.emptyBtn,
                  { backgroundColor: colors.cobalt, borderRadius: colors.radius },
                  pressed && { opacity: 0.9 }
                ]}
              >
                <Text style={styles.emptyBtnText}>Start a new conversation</Text>
              </Pressable>
            </View>
          </View>
        </View>
       ) : (
        <FlatList
          testID="history-list"
          data={conversations}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          ListFooterComponent={
            loadingMore ? (
               <CoachHistorySkeleton backgroundColor={colors.card} borderColor={colors.border} placeholderColor={colors.track} radius={colors.radius} loadMore />
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
                 <Feather name="chevron-right" size={18} color={colors.subtleText} style={styles.rowChevron} />
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
    paddingHorizontal: 16,
  },
  memoriesLink: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    minHeight: 52,
    paddingVertical: 14,
  },
  memoriesLinkText: {
    flex: 1,
    minWidth: 0,
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
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  errorState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  stateContent: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
  },
  errorMessage: {
    width: "100%",
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
    maxWidth: 340,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 20,
  },
  emptyActions: {
    width: "100%",
    maxWidth: 280,
    gap: 12,
  },
  emptyBtn: {
    minHeight: 48,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyBtnText: {
    color: "#fff",
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  emptyBtnSecondary: {
    borderWidth: 1,
  },
  emptyBtnSecondaryText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
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
