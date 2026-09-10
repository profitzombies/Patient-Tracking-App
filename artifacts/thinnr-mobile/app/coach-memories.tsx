import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
  AccessibilityInfo,
  TextInput,
  KeyboardAvoidingView,
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
import { listPatientCoachMemories, updatePatientCoachMemory } from "@workspace/api-client-react";
import type { CoachMemory, CoachMemoryUpdateInputAction } from "@workspace/api-client-react";
import { ErrorBox } from "@/components/onboarding/OnboardingFields";
import { PageFlatList as FlatList } from "@/components/ui/PageScrollView";

export default function CoachMemoriesScreen() {
  const accountState = usePatientAccount();
  const accountKey = accountState.account.kind === "real" ? accountState.account.patientId : accountState.account.kind;
  const accountEpochRef = useRef({ key: accountKey, value: 0 });
  if (accountEpochRef.current.key !== accountKey) {
    accountEpochRef.current = { key: accountKey, value: accountEpochRef.current.value + 1 };
  }

  return (
    <CoachMemoriesContent
      key={`${accountKey}:${accountEpochRef.current.value}`}
      accountState={accountState}
      accountEpoch={accountEpochRef.current.value}
      accountEpochRef={accountEpochRef}
    />
  );
}

function CoachMemoriesContent({
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
  const { account, resolving, getAccessToken } = accountState;
  const { selectConversation } = useCoachChat();

  const accountKey = account.kind === "real" ? account.patientId : account.kind;
  const isCurrent = useCallback(
    () => accountEpochRef.current.value === accountEpoch && accountEpochRef.current.key === accountKey,
    [accountEpoch, accountEpochRef, accountKey],
  );

  const [activeTab, setActiveTab] = useState<"active" | "pending" | "removed">("active");
  
  const [memories, setMemories] = useState<CoachMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingMemoryId, setPendingMemoryId] = useState<string | null>(null);
  const [sourceLoadingId, setSourceLoadingId] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const loadMoreLockRef = useRef(false);
  const mutationLockRef = useRef(false);
  const sourceLockRef = useRef(false);

  const load = useCallback(async () => {
    if (resolving || account.kind !== 'real') return;
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    try {
      // Pin the bearer token before entering the generated client's global
      // auth path so an account transition cannot authenticate this request
      // as the next patient.
      const token = await getAccessToken?.();
      if (!token) throw new Error("Authentication is unavailable.");
      if (!isCurrent()) return;
      const page = await listPatientCoachMemories({ offset: 0, limit: 20 }, { headers: { Authorization: `Bearer ${token}` } });
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setMemories(page.memories);
      setNextOffset(page.nextOffset);
    } catch {
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setError("Failed to load memories. Please try again.");
    } finally {
      if (isCurrent() && listRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [account.kind, getAccessToken, isCurrent, resolving]);

  useFocusEffect(
    useCallback(() => {
      if (!resolving && account.kind === 'real') {
        load();
      }
    }, [resolving, account, load])
  );

  const loadMore = async () => {
    if (loading || loadingMore || nextOffset === null || error || account.kind !== 'real' || loadMoreLockRef.current) return;
    const requestId = ++listRequestRef.current;
    const requestedOffset = nextOffset;
    loadMoreLockRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const token = await getAccessToken?.();
      if (!token) throw new Error("Authentication is unavailable.");
      if (!isCurrent()) return;
      const page = await listPatientCoachMemories({ offset: requestedOffset, limit: 20 }, { headers: { Authorization: `Bearer ${token}` } });
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setMemories(prev => {
        const existing = new Set(prev.map(m => m.id));
        const additions = page.memories.filter(m => !existing.has(m.id));
        return [...prev, ...additions];
      });
      setNextOffset(page.nextOffset);
    } catch {
      if (!isCurrent() || listRequestRef.current !== requestId) return;
      setLoadMoreError("Couldn't load more memories. Please try again.");
    } finally {
      loadMoreLockRef.current = false;
      if (isCurrent() && listRequestRef.current === requestId) {
        setLoadingMore(false);
      }
    }
  };

  const handleSourceTap = async (sourceConversationId: string | null, sourceMessageId: string | null) => {
    if (!sourceConversationId || sourceLockRef.current) return;
    sourceLockRef.current = true;
    Haptics.selectionAsync();
    setSourceLoadingId(sourceConversationId);
    try {
      await selectConversation(sourceConversationId);
      if (!isCurrent()) return;
      router.push(`/coach-chat?messageId=${sourceMessageId ? encodeURIComponent(sourceMessageId) : ""}`);
    } catch {
      if (!isCurrent()) return;
      if (Platform.OS === 'web') {
        window.alert("Failed to open conversation. Please try again.");
      } else {
        Alert.alert("Error", "Failed to open conversation. Please try again.");
      }
    } finally {
      sourceLockRef.current = false;
      if (isCurrent()) setSourceLoadingId(null);
    }
  };

  const handleAction = async (memory: CoachMemory, action: CoachMemoryUpdateInputAction, newText?: string) => {
    if (mutationLockRef.current || account.kind !== "real") return;
    mutationLockRef.current = true;
    Haptics.selectionAsync();
    setActionError(null);
    setPendingMemoryId(memory.id);
    try {
      const token = await getAccessToken?.();
      if (!token) throw new Error("Authentication is unavailable.");
      if (!isCurrent()) return;
      const result = await updatePatientCoachMemory(
        memory.id,
        { action, expectedVersion: memory.version, text: newText },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!isCurrent()) return;
      if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(`Memory ${action}d`);
      setMemories(prev => {
        // Corrections supersede the old id. Replace by the request id, rather
        // than response id, so the old active card cannot remain visible.
        if (action === "correct") return prev.map(m => m.id === memory.id ? result.memory : m);
        return prev.map(m => m.id === memory.id ? result.memory : m);
      });
      if (action === "correct") {
        setEditingId(null);
        setEditText("");
      }
    } catch {
      if (isCurrent()) setActionError("Couldn't update that memory. Please try again.");
    } finally {
      mutationLockRef.current = false;
      if (isCurrent()) setPendingMemoryId(null);
    }
  };

  const confirmRememberAgain = (memory: CoachMemory) => {
    const continueRemembering = () => void handleAction(memory, "approve");
    if (Platform.OS === "web") {
      if (window.confirm("Let the AI Coach use this memory again?")) continueRemembering();
      return;
    }
    Alert.alert("Remember again?", "Let the AI Coach use this memory again?", [
      { text: "Cancel", style: "cancel" },
      { text: "Remember", onPress: continueRemembering },
    ]);
  };

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top;

  if (resolving || account.kind === 'unresolved') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.cobalt} />
      </View>
    );
  }

  if (account.kind === 'demo') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.headerBand, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: topPad }]}>
          <View style={styles.headerRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={() => router.back()}
              style={({ pressed }) => [
                styles.iconBtn,
                { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
                pressed && { backgroundColor: colors.accent }
              ]}
            >
              <Feather name="chevron-left" size={18} color={colors.navy} />
            </Pressable>
            <View style={styles.headerCenter}>
              <Text style={[styles.headerTitle, { color: colors.navy }]}>What the coach remembers</Text>
            </View>
            <View style={styles.iconBtnPlaceholder} />
          </View>
        </View>
        <View style={styles.emptyState}>
          <Feather name="database" size={32} color={colors.mutedForeground} style={styles.emptyIcon} />
          <Text style={[styles.emptyTitle, { color: colors.navy }]}>No Memories Yet</Text>
          <Text style={[styles.emptyBody, { color: colors.bodyText }]}>
            In the full program, the AI Coach learns preferences and details from your conversations to provide better guidance.
          </Text>
        </View>
      </View>
    );
  }

  const displayMemories = memories.filter(m => {
    if (activeTab === "active") return m.state === "active";
    if (activeTab === "pending") return m.state === "pending";
    return m.state === "removed" || m.state === "declined"; // "removed" combines declined and forgotten visually
  });

  const isMutating = pendingMemoryId !== null;

  const renderMemory = ({ item }: { item: CoachMemory }) => {
    const isEditing = editingId === item.id;
    const isPending = item.state === "pending";
    const isRemoved = item.state === "removed" || item.state === "declined";
    const isItemMutating = pendingMemoryId === item.id;

    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius }]}>
        <View style={styles.cardHeader}>
          <View style={[styles.categoryBadge, { backgroundColor: colors.accent }]}>
            <Text style={[styles.categoryText, { color: colors.cobalt }]}>{item.category || "General"}</Text>
          </View>
          {item.sourceCreatedAt && (
            <Text style={[styles.dateText, { color: colors.subtleText }]}>
              {new Date(item.sourceCreatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Text>
          )}
        </View>

        {isEditing ? (
          <View style={styles.editContainer}>
            <TextInput
              style={[styles.editInput, { color: colors.navy, borderColor: colors.border, backgroundColor: colors.background, borderRadius: colors.radiusSm }]}
              value={editText}
              onChangeText={setEditText}
              multiline
              autoFocus
              editable={!isMutating}
            />
            <View style={styles.editActions}>
              <Pressable
                onPress={() => setEditingId(null)}
                disabled={isMutating}
                style={({ pressed }) => [styles.editBtn, (pressed || isMutating) && { opacity: 0.7 }]}
              >
                <Text style={[styles.editBtnText, { color: colors.subtleText }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => handleAction(item, 'correct', editText)}
                disabled={isMutating}
                style={({ pressed }) => [styles.editBtnPrimary, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }, (pressed || isMutating) && { opacity: 0.7 }]}
              >
                {isMutating ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.editBtnPrimaryText}>Save</Text>}
              </Pressable>
            </View>
          </View>
        ) : (
          <Text style={[styles.memoryText, { color: colors.navy, textDecorationLine: isRemoved ? "line-through" : "none" }]}>
            {item.text}
          </Text>
        )}

        {!isEditing && (
          <View style={styles.cardActions}>
            {isPending ? (
              <View style={styles.pendingBlock}>
                <Text style={[styles.pendingContext, { color: colors.bodyText }]}>
                  The AI Coach noticed this sensitive detail. Approve to let the coach remember it, or decline.
                </Text>
                <View style={styles.actionRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleAction(item, 'decline')}
                    disabled={isMutating}
                    style={({ pressed }) => [styles.actionBtn, { borderColor: colors.border, borderRadius: colors.radiusSm }, (pressed || isMutating) && { opacity: 0.7 }]}
                  >
                    {isItemMutating ? <ActivityIndicator size="small" color={colors.subtleText} /> : (
                      <>
                        <Feather name="x" size={14} color={colors.subtleText} style={styles.actionIcon} />
                        <Text style={[styles.actionBtnText, { color: colors.subtleText }]}>Decline</Text>
                      </>
                    )}
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleAction(item, 'approve')}
                    disabled={isMutating}
                    style={({ pressed }) => [styles.actionBtnPrimary, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }, (pressed || isMutating) && { opacity: 0.7 }]}
                  >
                    {isItemMutating ? <ActivityIndicator size="small" color="#fff" /> : (
                      <>
                        <Feather name="check" size={14} color="#fff" style={styles.actionIcon} />
                        <Text style={styles.actionBtnPrimaryText}>Approve</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : isRemoved ? (
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remember again"
                  onPress={() => confirmRememberAgain(item)}
                  disabled={isMutating}
                  style={({ pressed }) => [styles.smallActionBtn, (pressed || isMutating) && { opacity: 0.7 }]}
                >
                  {isItemMutating ? <ActivityIndicator size="small" color={colors.cobalt} /> : (
                    <>
                      <Feather name="rotate-ccw" size={14} color={colors.cobalt} style={styles.actionIcon} />
                      <Text style={[styles.smallActionText, { color: colors.cobalt }]}>Remember again</Text>
                    </>
                  )}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit and remember"
                  onPress={() => {
                    Haptics.selectionAsync();
                    setEditText(item.text);
                    setEditingId(item.id);
                  }}
                  disabled={isMutating}
                  style={({ pressed }) => [styles.smallActionBtn, (pressed || isMutating) && { opacity: 0.7 }]}
                >
                  <Feather name="edit-2" size={14} color={colors.subtleText} style={styles.actionIcon} />
                  <Text style={[styles.smallActionText, { color: colors.subtleText }]}>Edit</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit memory"
                  onPress={() => {
                    Haptics.selectionAsync();
                    setEditText(item.text);
                    setEditingId(item.id);
                  }}
                  disabled={isMutating}
                  style={({ pressed }) => [styles.smallActionBtn, (pressed || isMutating) && { opacity: 0.7 }]}
                >
                  <Feather name="edit-2" size={14} color={colors.subtleText} style={styles.actionIcon} />
                  <Text style={[styles.smallActionText, { color: colors.subtleText }]}>Edit</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Forget memory"
                  onPress={() => void handleAction(item, 'forget')}
                  disabled={isMutating}
                  style={({ pressed }) => [styles.smallActionBtn, (pressed || isMutating) && { opacity: 0.7 }]}
                >
                  {isItemMutating ? <ActivityIndicator size="small" color={colors.riskText} /> : (
                    <>
                      <Feather name="trash-2" size={14} color={colors.riskText} style={styles.actionIcon} />
                      <Text style={[styles.smallActionText, { color: colors.riskText }]}>Forget</Text>
                    </>
                  )}
                </Pressable>
              </View>
            )}
            
            {item.sourceConversationId && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View source conversation"
                onPress={() => void handleSourceTap(item.sourceConversationId, item.sourceMessageId)}
                disabled={sourceLoadingId === item.sourceConversationId}
                style={({ pressed }) => [styles.sourceLink, pressed && { opacity: 0.7 }]}
              >
                {sourceLoadingId === item.sourceConversationId ? <ActivityIndicator size="small" color={colors.cobalt} /> : <Feather name="message-circle" size={12} color={colors.cobalt} style={styles.actionIcon} />}
                <Text style={[styles.sourceLinkText, { color: colors.cobalt }]}>View source</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.headerBand, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: topPad }]}>
        <View style={styles.headerRow}>
          <Pressable
            testID="memories-back"
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
            <Text style={[styles.headerTitle, { color: colors.navy }]}>What the coach remembers</Text>
          </View>
          <View style={styles.iconBtnPlaceholder} />
        </View>
        <View style={styles.tabsRow} accessibilityRole="tablist">
          <Pressable
            testID="tab-active"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === "active" }}
            aria-selected={activeTab === "active"}
            onPress={() => {
              if (activeTab !== "active") {
                Haptics.selectionAsync();
                setActiveTab("active");
              }
            }}
            style={[styles.tab, activeTab === "active" && { borderBottomColor: colors.cobalt }]}
          >
            <Text style={[styles.tabText, { color: activeTab === "active" ? colors.cobalt : colors.subtleText }]}>Active</Text>
          </Pressable>
          <Pressable
            testID="tab-pending"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === "pending" }}
            aria-selected={activeTab === "pending"}
            onPress={() => {
              if (activeTab !== "pending") {
                Haptics.selectionAsync();
                setActiveTab("pending");
              }
            }}
            style={[styles.tab, activeTab === "pending" && { borderBottomColor: colors.cobalt }]}
          >
            <View style={styles.pendingTabInner}>
              <Text style={[styles.tabText, { color: activeTab === "pending" ? colors.cobalt : colors.subtleText }]}>Review</Text>
              {memories.some(m => m.state === "pending") && (
                <View style={[styles.badge, { backgroundColor: colors.orange }]} />
              )}
            </View>
          </Pressable>
          <Pressable
            testID="tab-removed"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === "removed" }}
            aria-selected={activeTab === "removed"}
            onPress={() => {
              if (activeTab !== "removed") {
                Haptics.selectionAsync();
                setActiveTab("removed");
              }
            }}
            style={[styles.tab, activeTab === "removed" && { borderBottomColor: colors.cobalt }]}
          >
            <Text style={[styles.tabText, { color: activeTab === "removed" ? colors.cobalt : colors.subtleText }]}>Removed</Text>
          </Pressable>
        </View>
      </View>

      {activeTab === "active" && (
        <View style={[styles.noticeBand, { backgroundColor: colors.accent }]}>
          <Feather name="info" size={14} color={colors.cobalt} style={styles.noticeIcon} />
          <Text style={[styles.noticeText, { color: colors.navy }]}>
            Forgetting a memory stops the AI from using it, but the original message remains in your chat history.
          </Text>
        </View>
      )}

      {actionError ? <View style={styles.actionError}><ErrorBox testID="memories-action-error" message={actionError} /></View> : null}

      {error ? (
        <View style={styles.errorState} accessibilityRole="alert">
          <ErrorBox testID="memories-error" message={error} />
          <Pressable
            testID="memories-retry"
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
      ) : displayMemories.length === 0 && nextOffset === null ? (
        <View style={styles.emptyState}>
          <Feather 
            name={activeTab === "active" ? "database" : activeTab === "pending" ? "check-circle" : "trash-2"} 
            size={32} 
            color={colors.mutedForeground} 
            style={styles.emptyIcon} 
          />
          <Text style={[styles.emptyTitle, { color: colors.navy }]}>
            {activeTab === "active" ? "No Active Memories" : activeTab === "pending" ? "All Caught Up" : "No Removed Memories"}
          </Text>
          <Text style={[styles.emptyBody, { color: colors.bodyText }]}>
            {activeTab === "active" 
              ? "The AI Coach learns from your conversations. Important details it remembers will appear here." 
              : activeTab === "pending" 
              ? "No memories need your review right now."
              : "Memories you decline or forget will appear here in case you want to restore them."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={displayMemories}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          ListEmptyComponent={
            nextOffset !== null ? (
              <View style={styles.checkMoreState} testID="memories-check-more">
                <Text style={[styles.checkMoreText, { color: colors.bodyText }]}>
                  Load more to check for {activeTab === "pending" ? "review" : activeTab} memories.
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={colors.subtleText} />
              </View>
            ) : loadMoreError ? (
               <View style={styles.footerLoader}>
                 <ErrorBox testID="memories-load-more-error" message={loadMoreError} />
                 <Pressable testID="memories-load-more-retry" accessibilityRole="button" onPress={loadMore}>
                    <Text style={{ color: colors.cobalt, fontFamily: fonts.sansMedium }}>Retry load more</Text>
                 </Pressable>
               </View>
            ) : nextOffset !== null ? (
               <Pressable testID="memories-load-more" accessibilityRole="button" onPress={loadMore} style={styles.footerLoader}>
                 <Text style={{ color: colors.cobalt, fontFamily: fonts.sansMedium }}>Load more...</Text>
               </Pressable>
            ) : null
          }
          renderItem={renderMemory}
        />
      )}
    </KeyboardAvoidingView>
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
  iconBtnPlaceholder: {
    width: 36,
    height: 36,
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
  pendingTabInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  badge: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  noticeBand: {
    flexDirection: "row",
    padding: 16,
    alignItems: "flex-start",
  },
  noticeIcon: {
    marginTop: 2,
    marginRight: 8,
  },
  noticeText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
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
  actionError: {
    paddingHorizontal: 16,
    paddingTop: 12,
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
    gap: 16,
  },
  checkMoreState: {
    alignItems: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  checkMoreText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  card: {
    borderWidth: 1,
    padding: 16,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  categoryText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    textTransform: "uppercase",
  },
  dateText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
  },
  memoryText: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
  },
  cardActions: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.05)",
  },
  pendingBlock: {
    gap: 12,
  },
  pendingContext: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderWidth: 1,
    gap: 8,
  },
  actionBtnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  actionBtnPrimary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    gap: 8,
  },
  actionBtnPrimaryText: {
    color: "#fff",
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  actionIcon: {
    marginTop: -1,
  },
  smallActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingRight: 16,
    gap: 6,
  },
  smallActionText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
  },
  sourceLink: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    marginTop: 8,
    gap: 6,
  },
  sourceLinkText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
  },
  editContainer: {
    gap: 12,
  },
  editInput: {
    borderWidth: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    padding: 12,
    minHeight: 80,
    textAlignVertical: "top",
  },
  editActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
  editBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    justifyContent: "center",
  },
  editBtnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  editBtnPrimary: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    justifyContent: "center",
  },
  editBtnPrimaryText: {
    color: "#fff",
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  footerLoader: {
    paddingVertical: 16,
    alignItems: "center",
  }
});
