import { useEffect, useMemo, useState } from "react";
import {
  getGetOfficePatientCoachConversationQueryKey,
  getListOfficePatientCoachConversationsQueryKey,
  getListOfficePatientCoachMemoriesQueryKey,
  type CoachChatWireMessage,
  useGetOfficePatientCoachConversation,
  useListOfficePatientCoachConversations,
  useListOfficePatientCoachMemories,
} from "@workspace/api-client-react";
import { formatRelativeTime } from "@/components/conversations/shared";
import { BTN_SECONDARY, CHIP_WARM, SectionCard } from "@/components/patient/heritage";
import { ArrowLeft, Brain, MessagesSquare } from "lucide-react";
import { useSession } from "@/contexts/session";

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

/** A provider read surface. It deliberately has no mutation/archive controls. */
export function CoachReviewPanel({ patientId, office, isHq: _isHq, initialConversationId = null }: { patientId: string; office: string | null; isHq?: boolean; initialConversationId?: string | null }) {
  const { providerAccountCode, authUser } = useSession();
  // Remounting clears private, in-flight selections before a new scope can paint.
  // The opaque WeakMap id changes on a new auth-session object without ever
  // placing an access token (or a token derivative) in TanStack cache keys.
  const scopeKey = `${authUser ? opaqueSessionScope(authUser) : "signed-out"}:${authUser?.id ?? "none"}:${providerAccountCode ?? "none"}:${office ?? "own"}:${patientId}`;
  return <CoachReviewPanelScope key={scopeKey} patientId={patientId} office={office} sessionKey={scopeKey} authorized={!!authUser} initialConversationId={initialConversationId} />;
}

function CoachReviewPanelScope({ patientId, office, sessionKey, authorized, initialConversationId }: { patientId: string; office: string | null; sessionKey: string; authorized: boolean; initialConversationId: string | null }) {
  const [activeTab, setActiveTab] = useState<"conversations" | "memories">("conversations");
  // A deep link (flagged chat) opens its transcript first; Back returns to the list.
  const [selected, setSelected] = useState<SelectedConversation | null>(initialConversationId ? { id: initialConversationId } : null);
  const [convOffset, setConvOffset] = useState(0);
  const [memOffset, setMemOffset] = useState(0);
  const [conversationPages, setConversationPages] = useState<any[]>([]);
  const [memoryPages, setMemoryPages] = useState<any[]>([]);
  // Provider endpoint intentionally returns both active and archived conversations.
  const convParams = { limit: 20, offset: convOffset, office: office ?? undefined };
  const memParams = { limit: 20, offset: memOffset, office: office ?? undefined };
  const convList = useListOfficePatientCoachConversations(patientId, convParams, {
    query: {
      enabled: authorized && !!patientId && !selected && activeTab === "conversations",
      queryKey: [sessionKey, ...getListOfficePatientCoachConversationsQueryKey(patientId, convParams)],
    },
  });
  const memoryList = useListOfficePatientCoachMemories(patientId, memParams, {
    query: {
      enabled: authorized && !!patientId && !selected && activeTab === "memories",
      queryKey: [sessionKey, ...getListOfficePatientCoachMemoriesQueryKey(patientId, memParams)],
    },
  });

  useEffect(() => {
    if (!convList.data) return;
    setConversationPages(previous => convOffset === 0
      ? convList.data!.conversations
      : mergeById(previous, convList.data!.conversations));
  }, [convList.data, convOffset]);
  useEffect(() => {
    if (!memoryList.data) return;
    setMemoryPages(previous => memOffset === 0
      ? memoryList.data!.memories
      : mergeById(previous, memoryList.data!.memories));
  }, [memoryList.data, memOffset]);

  if (selected) {
    return (
      <SectionCard title="AI Coach Transcript" action={
        <button onClick={() => setSelected(null)} className={`${BTN_SECONDARY} h-8 px-3 text-[10px]`}>
          <ArrowLeft size={12} className="mr-1 inline" /> Back
        </button>
      }>
        <ConversationTranscript
          patientId={patientId}
          conversationId={selected.id}
          sourceMessageId={selected.sourceMessageId}
          office={office}
          sessionKey={sessionKey}
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="AI Coach History" sub="Read-only view of patient AI conversations and patient-reported memories.">
      <div className="flex border-b border-border bg-secondary/50 px-2 pt-2">
        <Tab active={activeTab === "conversations"} onClick={() => setActiveTab("conversations")} icon={<MessagesSquare size={14} />}>Conversations</Tab>
        <Tab active={activeTab === "memories"} onClick={() => setActiveTab("memories")} icon={<Brain size={14} />}>Memories</Tab>
      </div>
      <div className="p-5">
        {activeTab === "conversations" && (
          <div>
            {convList.isError ? <Failure text="Failed to load conversations." /> : convList.isLoading && !conversationPages.length ? <Loading text="Loading conversations..." /> : conversationPages.length ? (
              <div className="divide-y divide-border">
                {conversationPages.map(conv => (
                  <div key={conv.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-navy">{conv.title || "New conversation"}
                        {conv.archivedAt && <span className="ml-2 rounded border border-border bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">Archived</span>}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Started {new Date(conv.createdAt).toLocaleDateString()} · Updated {formatRelativeTime(conv.updatedAt)}</p>
                    </div>
                    <button onClick={() => setSelected({ id: conv.id })} className={`${BTN_SECONDARY} h-8 shrink-0 px-3 text-xs`}>View transcript</button>
                  </div>
                ))}
              </div>
            ) : <Empty text="No AI coach conversations found." />}
            <MoreButton nextOffset={convList.data?.nextOffset} isFetching={convList.isFetching} onMore={() => setConvOffset(convList.data!.nextOffset!)} label="conversations" />
          </div>
        )}
        {activeTab === "memories" && (
          <div>
            {memoryList.isError ? <Failure text="Failed to load memories." /> : memoryList.isLoading && !memoryPages.length ? <Loading text="Loading memories..." /> : memoryPages.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {memoryPages.map(mem => (
                  <div key={mem.id} className="rounded-md border border-border bg-paper-alt p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm text-foreground">{mem.text}</p>
                      {mem.sensitivity === "sensitive" && <span className={`${CHIP_WARM} shrink-0`}>Sensitive</span>}
                    </div>
                    <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
                      <div className="flex items-center gap-2"><span className="uppercase tracking-wider">{mem.category}</span><span className="rounded border border-border bg-background px-1">Patient-reported — not clinically verified</span></div>
                      <span>Source date {new Date(mem.sourceCreatedAt ?? mem.createdAt).toLocaleDateString()}</span>
                    </div>
                    {mem.sourceConversationId && <button onClick={() => setSelected({ id: mem.sourceConversationId, sourceMessageId: mem.sourceMessageId })} className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"><ArrowLeft size={10} className="rotate-180" /> View source</button>}
                  </div>
                ))}
              </div>
            ) : <Empty text="No saved memories found." />}
            <MoreButton nextOffset={memoryList.data?.nextOffset} isFetching={memoryList.isFetching} onMore={() => setMemOffset(memoryList.data!.nextOffset!)} label="memories" />
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function ConversationTranscript({ patientId, conversationId, sourceMessageId, office, sessionKey }: { patientId: string; conversationId: string; sourceMessageId?: string | null; office: string | null; sessionKey: string }) {
  const [before, setBefore] = useState<number | undefined>();
  const [messages, setMessages] = useState<CoachChatWireMessage[]>([]);
  const params = { limit: 100, before, office: office ?? undefined };
  const detail = useGetOfficePatientCoachConversation(patientId, conversationId, params, {
    query: { queryKey: [sessionKey, ...getGetOfficePatientCoachConversationQueryKey(patientId, conversationId, params)] },
  });
  useEffect(() => {
    if (detail.data?.messages) setMessages(previous => mergeById(previous, detail.data!.messages).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
  }, [detail.data]);
  // A memory's source can be older than the first transcript page. Continue
  // through exclusive `before` cursors until it is found or history is exhausted.
  useEffect(() => {
    if (!sourceMessageId || !detail.data || messages.some(message => message.id === sourceMessageId)) return;
    if (detail.data.nextBefore !== null && detail.data.nextBefore !== undefined) setBefore(detail.data.nextBefore);
  }, [detail.data, messages, sourceMessageId]);

  if (detail.isError) return <Failure text="Failed to load transcript." />;
  if (detail.isLoading && !detail.data) return <Loading text="Loading transcript..." />;
  if (!detail.data) return null;
  const { conversation, patient } = detail.data;
  return (
    <div className="flex h-[600px] flex-col">
      <div className="border-b border-border bg-secondary p-3 text-xs"><p className="font-semibold text-navy">{conversation.title || "New conversation"} {conversation.archivedAt && <span className="ml-1 rounded border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">Archived</span>}</p><p className="mt-1 text-muted-foreground">Patient: {patient.firstName} · Day {patient.programDay}</p></div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {detail.data.nextBefore !== null && detail.data.nextBefore !== undefined && !sourceMessageId && <button onClick={() => setBefore(detail.data!.nextBefore!)} disabled={detail.isFetching} className={`mx-auto block ${BTN_SECONDARY} h-8 px-4 text-xs`}>{detail.isFetching ? "Loading..." : "Load older messages"}</button>}
        {sourceMessageId && !messages.some(message => message.id === sourceMessageId) && detail.data.nextBefore !== null && <Loading text="Locating source message..." />}
        {messages.map(message => <MessageBubble key={message.id} message={message} patientName={patient.firstName} highlighted={message.id === sourceMessageId} />)}
        {!messages.length && !detail.isFetching && <Empty text="No messages in this conversation." />}
      </div>
    </div>
  );
}

function MessageBubble({ message, patientName, highlighted }: { message: CoachChatWireMessage; patientName: string; highlighted: boolean }) {
  const assistant = message.role === "assistant";
  return <div className={`flex ${assistant ? "justify-start" : "justify-end"}`} data-source-message={highlighted || undefined}>
    <div className={`max-w-[85%] rounded-lg p-3 ${assistant ? "bg-secondary" : "bg-primary text-primary-foreground"} ${highlighted ? "ring-2 ring-primary ring-offset-2" : ""}`}>
      <p className="mb-1 text-[11px] font-semibold opacity-70">{assistant ? "AI Coach" : patientName}</p>
      <p className="whitespace-pre-wrap text-sm">{message.text}</p>
      <ReadOnlyAttachment message={message} />
      {message.createdAt && <p className="mt-2 text-right text-[9px] opacity-60">{formatRelativeTime(message.createdAt)}</p>}
    </div>
  </div>;
}

function ReadOnlyAttachment({ message }: { message: CoachChatWireMessage }) {
  const photo = message.photo as Record<string, unknown> | undefined;
  const card = message.card as Record<string, unknown> | undefined;
  const photoUri = photo && ["uri", "url", "secureUrl", "signedUrl"].map(key => photo[key]).find(value => typeof value === "string" && value.length > 0) as string | undefined;
  const payload = card?.payload as Record<string, unknown> | undefined;
  const cardTitle = card && [card.title, card.name, payload?.title, payload?.name].find(value => typeof value === "string") as string | undefined;
  const cardFields = payload && typeof payload === "object"
    ? Object.entries(payload).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 4)
    : [];
  return <>
    {photoUri && <img src={photoUri} alt="Patient shared photo" className="mt-2 max-h-64 w-full rounded object-cover" />}
    {card && <div className="mt-2 rounded border border-current/20 bg-black/5 p-2 text-xs"><p className="font-semibold">{cardTitle ?? (typeof card.kind === "string" ? card.kind : "Coach card")}</p>{typeof card.description === "string" && <p className="mt-1">{card.description}</p>}{cardFields.map(([key, value]) => <p key={key} className="mt-1"><span className="font-medium">{key}: </span>{String(value)}</p>)}</div>}
  </>;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) { return [...current, ...incoming.filter(item => !current.some(existing => existing.id === item.id))]; }
function Tab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) { return <button onClick={onClick} className={`flex items-center gap-2 rounded-t-md px-4 py-2 text-xs font-semibold ${active ? "bg-card text-navy shadow-[0_-1px_2px_rgba(0,0,0,0.05)]" : "text-muted-foreground hover:bg-black/5"}`}>{icon}{children}</button>; }
function MoreButton({ nextOffset, isFetching, onMore, label }: { nextOffset: number | null | undefined; isFetching: boolean; onMore: () => void; label: string }) { return nextOffset !== null && nextOffset !== undefined ? <button onClick={onMore} disabled={isFetching} className={`mt-4 ${BTN_SECONDARY} h-8 w-full px-4`}>{isFetching ? "Loading..." : `Load more ${label}`}</button> : null; }
function Loading({ text }: { text: string }) { return <p className="text-xs text-muted-foreground">{text}</p>; }
function Empty({ text }: { text: string }) { return <p className="text-xs text-muted-foreground">{text}</p>; }
function Failure({ text }: { text: string }) { return <p className="text-xs text-destructive">{text}</p>; }