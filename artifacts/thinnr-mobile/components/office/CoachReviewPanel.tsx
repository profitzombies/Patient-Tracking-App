import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Image } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import theme from '@/constants/colors';
import { SectionHeader, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import {
  type CoachChatWireMessage,
  useGetOfficePatientCoachConversation,
  useListOfficePatientCoachConversations,
  useListOfficePatientCoachMemories,
} from '@workspace/api-client-react';

function formatDate(date: string | Date) { return new Date(date).toLocaleDateString('en-US'); }
function formatRelativeTime(date: string | Date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return formatDate(date);
}
type SelectedConversation = { id: string; sourceMessageId?: string | null };
const sessionScopeIds = new WeakMap<object, string>();
let nextSessionScopeId = 0;
function opaqueSessionScope(sessionObject: object): string {
  let scope = sessionScopeIds.get(sessionObject);
  if (!scope) {
    scope = `provider-session-${++nextSessionScopeId}`;
    sessionScopeIds.set(sessionObject, scope);
  }
  return scope;
}

/** Provider-only, read-only history. The server list includes active + archived threads. */
export function CoachReviewPanel({ patientId, session }: { patientId: string; session: { access_token: string; user: { id: string } } }) {
  // Keep the bearer only in request headers. This opaque per-object scope
  // invalidates cached panels on same-user reauthentication without leaking it.
  const key = `${opaqueSessionScope(session)}:${session.user.id}:${patientId}`;
  return <CoachReviewPanelScope key={key} patientId={patientId} session={session} sessionKey={key} />;
}

function CoachReviewPanelScope({ patientId, session, sessionKey }: { patientId: string; session: { access_token: string; user: { id: string } }; sessionKey: string }) {
  const colors = useColors();
  const [tab, setTab] = useState<'conversations' | 'memories'>('conversations');
  const [selected, setSelected] = useState<SelectedConversation | null>(null);
  const [convOffset, setConvOffset] = useState(0);
  const [memOffset, setMemOffset] = useState(0);
  const [conversations, setConversations] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const request = { headers: { Authorization: `Bearer ${session.access_token}` } };
  const convList = useListOfficePatientCoachConversations(patientId, { limit: 20, offset: convOffset }, {
    query: { enabled: !!patientId && !selected && tab === 'conversations', queryKey: ['coach-conversations', sessionKey, convOffset] },
    request,
  });
  const memoryList = useListOfficePatientCoachMemories(patientId, { limit: 20, offset: memOffset }, {
    query: { enabled: !!patientId && !selected && tab === 'memories', queryKey: ['coach-memories', sessionKey, memOffset] },
    request,
  });
  useEffect(() => {
    if (convList.data) setConversations(previous => convOffset === 0 ? convList.data!.conversations : mergeById(previous, convList.data!.conversations));
  }, [convList.data, convOffset]);
  useEffect(() => {
    if (memoryList.data) setMemories(previous => memOffset === 0 ? memoryList.data!.memories : mergeById(previous, memoryList.data!.memories));
  }, [memoryList.data, memOffset]);

  if (selected) return <View style={styles.section}><LedgerCard>
    <View style={[styles.transcriptHeader, { borderBottomColor: colors.border }]}>
      <Pressable onPress={() => setSelected(null)} style={styles.backButton}><Feather name="arrow-left" size={16} color={colors.cobalt} /><Text style={[styles.backText, { color: colors.cobalt }]}>Back</Text></Pressable>
      <Text style={[styles.transcriptTitle, { color: colors.foreground }]}>AI Coach Transcript</Text>
    </View>
    <ConversationTranscript patientId={patientId} conversationId={selected.id} sourceMessageId={selected.sourceMessageId} request={request} sessionKey={sessionKey} />
  </LedgerCard></View>;

  return <View style={styles.section}>
    <SectionHeader label="AI Coach History" />
    <LedgerCard>
      <View style={[styles.tabBar, { borderBottomColor: colors.border, backgroundColor: colors.muted }]}>
        <Tab active={tab === 'conversations'} onPress={() => setTab('conversations')} icon="message-square">Conversations</Tab>
        <Tab active={tab === 'memories'} onPress={() => setTab('memories')} icon="cpu">Memories</Tab>
      </View>
      <View style={styles.tabContent}>
        {tab === 'conversations' && (convList.isError ? <Failure text="Failed to load conversations." /> : convList.isLoading && !conversations.length ? <ActivityIndicator color={colors.cobalt} style={styles.loading} /> : conversations.length ? <>
          {conversations.map((conversation, index) => <View key={conversation.id} style={[styles.row, { borderBottomColor: colors.border, borderBottomWidth: index === conversations.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
            <View style={styles.rowInfo}><View style={styles.titleLine}><Text style={[styles.title, { color: colors.navy }]}>{conversation.title || 'New conversation'}</Text>{conversation.archivedAt && <View style={[styles.archived, { backgroundColor: colors.muted, borderColor: colors.border }]}><Text style={[styles.archivedText, { color: colors.subtleText }]}>ARCHIVED</Text></View>}</View><Text style={[styles.meta, { color: colors.subtleText }]}>Started {formatDate(conversation.createdAt)}</Text></View>
            <Pressable onPress={() => setSelected({ id: conversation.id })} style={[styles.view, { backgroundColor: colors.muted }]}><Text style={[styles.viewText, { color: colors.cobalt }]}>View</Text></Pressable>
          </View>)}
          <More nextOffset={convList.data?.nextOffset} fetching={convList.isFetching} onPress={() => setConvOffset(convList.data!.nextOffset!)} label="conversations" />
        </> : <Empty text="No AI coach conversations found." />)}
        {tab === 'memories' && (memoryList.isError ? <Failure text="Failed to load memories." /> : memoryList.isLoading && !memories.length ? <ActivityIndicator color={colors.cobalt} style={styles.loading} /> : memories.length ? <>
          {memories.map((memory, index) => <View key={memory.id} style={[styles.memory, { borderBottomColor: colors.border, borderBottomWidth: index === memories.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
            <Text style={[styles.memoryText, { color: colors.foreground }]}>{memory.text}</Text>
            <View style={styles.memoryMeta}><Text style={[styles.meta, { color: colors.subtleText }]}>{memory.category.toUpperCase()} · PATIENT-REPORTED — NOT CLINICALLY VERIFIED</Text><Text style={[styles.meta, { color: colors.subtleText }]}>Source date {formatDate(memory.sourceCreatedAt ?? memory.createdAt)}</Text></View>
            {memory.sourceConversationId && <Pressable onPress={() => setSelected({ id: memory.sourceConversationId, sourceMessageId: memory.sourceMessageId })}><Text style={[styles.source, { color: colors.cobalt }]}>View source conversation</Text></Pressable>}
          </View>)}
          <More nextOffset={memoryList.data?.nextOffset} fetching={memoryList.isFetching} onPress={() => setMemOffset(memoryList.data!.nextOffset!)} label="memories" />
        </> : <Empty text="No saved memories found." />)}
      </View>
    </LedgerCard>
  </View>;
}

function ConversationTranscript({ patientId, conversationId, sourceMessageId, request, sessionKey }: { patientId: string; conversationId: string; sourceMessageId?: string | null; request: any; sessionKey: string }) {
  const colors = useColors();
  const [before, setBefore] = useState<number | undefined>();
  const [messages, setMessages] = useState<CoachChatWireMessage[]>([]);
  const detail = useGetOfficePatientCoachConversation(patientId, conversationId, { limit: 100, before }, { query: { queryKey: ['coach-transcript', sessionKey, conversationId, before] }, request });
  useEffect(() => { if (detail.data?.messages) setMessages(previous => mergeById(previous, detail.data!.messages).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))); }, [detail.data]);
  useEffect(() => {
    if (!sourceMessageId || !detail.data || messages.some(message => message.id === sourceMessageId)) return;
    if (detail.data.nextBefore !== null && detail.data.nextBefore !== undefined) setBefore(detail.data.nextBefore);
  }, [detail.data, messages, sourceMessageId]);
  if (detail.isError) return <Failure text="Failed to load transcript." />;
  if (detail.isLoading && !detail.data) return <ActivityIndicator color={colors.cobalt} style={styles.loading} />;
  if (!detail.data) return null;
  const { patient, conversation } = detail.data;
  return <View style={styles.transcript}>
    <View style={[styles.transcriptMeta, { backgroundColor: colors.muted }]}><Text style={[styles.title, { color: colors.navy }]}>{conversation.title || 'New conversation'}{conversation.archivedAt ? ' (Archived)' : ''}</Text><Text style={[styles.meta, { color: colors.subtleText }]}>Patient: {patient.firstName} · Day {patient.programDay}</Text></View>
    <ScrollView contentContainerStyle={styles.messages}>
      {detail.data.nextBefore !== null && detail.data.nextBefore !== undefined && !sourceMessageId && <More nextOffset={detail.data.nextBefore} fetching={detail.isFetching} onPress={() => setBefore(detail.data!.nextBefore!)} label="older messages" />}
      {sourceMessageId && !messages.some(message => message.id === sourceMessageId) && detail.data.nextBefore !== null && <Text style={[styles.locating, { color: colors.subtleText }]}>Locating source message…</Text>}
      {messages.map(message => <Message key={message.id} message={message} patientName={patient.firstName} colors={colors} highlighted={message.id === sourceMessageId} />)}
      {!messages.length && !detail.isFetching && <Empty text="No messages in this conversation." />}
    </ScrollView>
  </View>;
}

function Message({ message, patientName, colors, highlighted }: { message: CoachChatWireMessage; patientName: string; colors: any; highlighted: boolean }) {
  const mine = message.role !== 'assistant';
  const photo = message.photo as Record<string, unknown> | undefined;
  const card = message.card as Record<string, unknown> | undefined;
  const photoUri = photo && ['uri', 'url', 'secureUrl', 'signedUrl'].map(key => photo[key]).find(value => typeof value === 'string' && value.length > 0) as string | undefined;
  const payload = card?.payload as Record<string, unknown> | undefined;
  const cardTitle = card && [card.title, card.name, payload?.title, payload?.name, card.kind].find(value => typeof value === 'string') as string | undefined;
  const cardFields = payload && typeof payload === 'object'
    ? Object.entries(payload).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 4)
    : [];
  return <View style={[styles.bubble, { alignSelf: mine ? 'flex-end' : 'flex-start', backgroundColor: mine ? colors.cobalt : colors.paperCardAlt }, highlighted && { borderColor: colors.cobalt, borderWidth: 2 }]}>
    <Text style={[styles.sender, { color: mine ? colors.primaryForeground : colors.subtleText }]}>{mine ? patientName : 'AI Coach'}</Text>
    <Text style={[styles.messageText, { color: mine ? colors.primaryForeground : colors.foreground }]}>{message.text}</Text>
    {photoUri && <Image source={{ uri: photoUri }} accessibilityLabel="Patient shared photo" style={styles.photo} resizeMode="cover" />}
    {card && <View style={[styles.card, { borderColor: mine ? colors.primaryForeground : colors.border }]}><Text style={[styles.cardTitle, { color: mine ? colors.primaryForeground : colors.foreground }]}>{cardTitle ?? 'Coach card'}</Text>{typeof card.description === 'string' && <Text style={[styles.cardText, { color: mine ? colors.primaryForeground : colors.foreground }]}>{card.description}</Text>}{cardFields.map(([key, value]) => <Text key={key} style={[styles.cardText, { color: mine ? colors.primaryForeground : colors.foreground }]}>{key}: {String(value)}</Text>)}</View>}
    {message.createdAt && <Text style={[styles.time, { color: mine ? colors.primaryForeground : colors.subtleText }]}>{formatRelativeTime(message.createdAt)}</Text>}
  </View>;
}

function Tab({ active, onPress, icon, children }: { active: boolean; onPress: () => void; icon: any; children: React.ReactNode }) { const colors = useColors(); return <Pressable onPress={onPress} style={[styles.tab, active && { backgroundColor: colors.card }]}><Feather name={icon} size={14} color={active ? colors.navy : colors.subtleText} /><Text style={[styles.tabText, { color: active ? colors.navy : colors.subtleText }]}>{children}</Text></Pressable>; }
function More({ nextOffset, fetching, onPress, label }: { nextOffset: number | null | undefined; fetching: boolean; onPress: () => void; label: string }) { const colors = useColors(); return nextOffset !== null && nextOffset !== undefined ? <Pressable onPress={onPress} disabled={fetching} style={[styles.more, { backgroundColor: colors.muted }]}><Text style={[styles.viewText, { color: colors.cobalt }]}>{fetching ? 'Loading…' : `Load more ${label}`}</Text></Pressable> : null; }
function Empty({ text }: { text: string }) { const colors = useColors(); return <Text style={[styles.empty, { color: colors.subtleText }]}>{text}</Text>; }
function Failure({ text }: { text: string }) { const colors = useColors(); return <Text style={[styles.empty, { color: colors.warnText }]}>{text}</Text>; }
function mergeById<T extends { id: string }>(current: T[], incoming: T[]) { return [...current, ...incoming.filter(item => !current.some(existing => existing.id === item.id))]; }

const styles = StyleSheet.create({
  section: { marginBottom: 24 }, loading: { padding: 20 }, tabBar: { flexDirection: 'row', borderBottomWidth: 1 }, tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, gap: 8 }, tabText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 }, tabContent: { minHeight: 100 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 }, rowInfo: { flex: 1, paddingRight: 12 }, titleLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }, title: { fontFamily: 'Inter_600SemiBold', fontSize: 14 }, meta: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 3 }, archived: { borderWidth: 1, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 }, archivedText: { fontFamily: 'Inter_700Bold', fontSize: 9 }, view: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: theme.radiusSm }, viewText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  memory: { padding: 16 }, memoryText: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 20 }, memoryMeta: { marginTop: 10, flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, source: { fontFamily: 'Inter_500Medium', fontSize: 11, marginTop: 8 }, more: { padding: 12, alignItems: 'center', margin: 16, borderRadius: theme.radiusSm }, empty: { padding: 20, textAlign: 'center', fontFamily: 'Inter_400Regular', fontSize: 13 },
  transcriptHeader: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1 }, backButton: { flexDirection: 'row', alignItems: 'center', padding: 8, marginRight: 8 }, backText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, marginLeft: 4 }, transcriptTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 15 }, transcript: { flex: 1, minHeight: 300 }, transcriptMeta: { padding: 12 }, messages: { padding: 12, gap: 16 }, locating: { textAlign: 'center', fontSize: 12 },
  bubble: { maxWidth: '85%', padding: 12, borderRadius: 12 }, sender: { fontFamily: 'Inter_600SemiBold', fontSize: 11, marginBottom: 4 }, messageText: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 20 }, time: { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 6, textAlign: 'right', opacity: 0.7 }, photo: { width: 220, height: 160, borderRadius: 8, marginTop: 8 }, card: { marginTop: 8, padding: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6 }, cardTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 12 }, cardText: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 3 },
});