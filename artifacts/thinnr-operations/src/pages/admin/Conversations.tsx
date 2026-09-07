import { useMemo, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, MessagesSquare, Search, X, AlertTriangle, StickyNote } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_SECONDARY, CHIP_WARM, WARM_TEXT } from '@/components/patient/heritage';
import { AccountStatusChip } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import { MOCK_PATIENTS, MOCK_PRODUCTS, type Patient } from '@/data/mock-data';
import type { ProviderAccount } from '@/data/hq/accounts';
import type { HqRole } from '@/data/hq/team';
import {
  conversationMatchesQuery,
  getConversationMessagesForRole,
  getConversationsForRole,
  type ConversationSearchFields,
  type HqCoachMessage,
  type HqConversationSummary,
  type HqRecipePayload,
} from '@/data/hq/conversations';
import {
  useGetOfficeConversations,
  useGetOfficeConversationEvents,
  useGetOfficeConversationSummary,
  useGetOfficeConversationStaff,
  useGetOfficeConversationNotes,
  useAssignOfficeConversation,
  useSetOfficeConversationStatus,
  useReplyOfficeConversation,
  useAddOfficeConversationNote,
  useEscalateOfficeConversation,
  getGetOfficeConversationsQueryKey,
  getGetOfficeConversationEventsQueryKey,
  getGetOfficeConversationNotesQueryKey,
  getGetOfficeConversationSummaryQueryKey,
  getGetOfficeConversationStaffQueryKey,
  type GetOfficeConversationsThread,
  type GetOfficeConversationsStatus,
  type GetOfficeConversationsSort,
  type ConversationEvent,
} from '@workspace/api-client-react';

/** One rail entry: the thread plus its resolved patient and provider account. */
interface RailRow {
  conv: HqConversationSummary;
  patient: Patient | undefined;
  account: ProviderAccount | undefined;
}

/** The identity fields the rail search runs over, per row. */
const searchFieldsOf = ({ patient, account }: RailRow): ConversationSearchFields => ({
  patientName: patient?.name,
  patientEmail: patient?.email,
  patientPhone: patient?.phone,
  officeName: account?.officeName,
  providerName: account?.providerName,
  providerCode: account?.providerCode ?? undefined,
});

function PatientAvatar({ patient }: { patient: Patient | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-[11px] font-bold text-primary"
    >
      {patient?.initials?.slice(0, 2) ?? '?'}
    </span>
  );
}

function InitialsAvatar({ name }: { name: string | undefined }) {
  const initials = (name || '')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-[11px] font-bold text-primary"
    >
      {initials || '?'}
    </span>
  );
}

function formatRelativeTime(dateString: string) {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return '';
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'MMM d, yyyy');
}

function RecipeCardPreview({ payload }: { payload: HqRecipePayload }) {
  const isCravings = payload.mode === 'cravings';
  return (
    <div className="mt-2 rounded-md border border-card-border bg-paper-alt p-3 shadow-xs">
      <p
        className="text-[9px] font-bold uppercase tracking-[.12em]"
        style={{ color: isCravings ? WARM_TEXT : undefined }}
      >
        <span className={isCravings ? undefined : 'text-primary'}>
          {isCravings ? 'Cravings fix · Approved foods only' : 'Recipe idea'}
        </span>
      </p>
      <p className="mt-1 font-serif text-sm font-bold leading-snug text-navy">{payload.name}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{payload.description}</p>
      <p className="mt-2 text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
        Est. {payload.calories} cal · {payload.protein}P · {payload.carbs}C · {payload.fat}F
      </p>
    </div>
  );
}

function ProductCardPreview({ productId }: { productId: string }) {
  // Re-resolved from the shared catalog at render time (the transcript only
  // stores the id), mirroring how the phone keeps product cards from drifting.
  const product = MOCK_PRODUCTS.find((entry) => entry.id === productId);
  if (!product) return null;
  return (
    <div className="mt-2 flex items-center gap-3 rounded-md border border-card-border bg-paper-alt p-3 shadow-xs">
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-bold uppercase tracking-[.12em] text-primary">THINNR product</p>
        <p className="mt-1 font-serif text-sm font-bold leading-snug text-navy">{product.name}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{product.description}</p>
      </div>
      {/* Display artifact of the phone CTA — not a live control in this viewer. */}
      <span className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.06em] text-primary-foreground" aria-hidden="true">
        View
      </span>
    </div>
  );
}

function MessageRow({ message }: { message: HqCoachMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] md:max-w-[72%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={
            isUser
              ? 'rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 text-primary-foreground shadow-xs'
              : 'rounded-lg rounded-bl-sm border border-card-border bg-card px-3.5 py-2.5 shadow-soft'
          }
        >
          {message.text.split('\n\n').map((block, index) => (
            <p
              key={index}
              className={`text-xs leading-relaxed ${index > 0 ? 'mt-2.5' : ''} ${isUser ? '' : 'text-foreground'}`}
            >
              {block}
            </p>
          ))}
        </div>

        {message.card?.kind === 'recipe' && <RecipeCardPreview payload={message.card.payload as HqRecipePayload} />}
        {message.card?.kind === 'product' && (
          <ProductCardPreview productId={(message.card.payload as { id: string }).id} />
        )}

        {message.quickReplies && message.quickReplies.length > 0 && (
          <div className="mt-2">
            <p className="text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">One-tap replies offered</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {message.quickReplies.map((label) => (
                <span
                  key={label}
                  className="rounded-md border border-accent-border bg-accent px-2.5 py-1 text-[11px] font-semibold text-primary"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}

        <p className={`mt-1.5 text-[10px] text-muted-foreground ${isUser ? 'text-right' : ''}`}>{message.atLabel}</p>
      </div>
    </div>
  );
}

function LiveMessageRow({ message }: { message: ConversationEvent }) {
  const isUser = message.role === 'user';
  const isStaff = message.role === 'staff';
  const timeLabel = format(new Date(message.createdAt), 'h:mm a');

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] md:max-w-[72%] ${isUser ? 'items-end' : 'items-start'}`}>
        {isStaff && <p className="mb-1 text-[10px] font-bold uppercase tracking-[.1em] text-primary">{message.senderLabel ?? 'Care team'}</p>}
        <div
          className={
            isUser
              ? 'rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 text-primary-foreground shadow-xs'
              : isStaff
                ? 'rounded-lg rounded-bl-sm border border-primary/25 bg-accent px-3.5 py-2.5 shadow-soft'
                : 'rounded-lg rounded-bl-sm border border-card-border bg-card px-3.5 py-2.5 shadow-soft'
          }
        >
          {message.text.split('\n\n').map((block, index) => (
            <p
              key={index}
              className={`text-xs leading-relaxed ${index > 0 ? 'mt-2.5' : ''} ${isUser ? '' : 'text-foreground'}`}
            >
              {block}
            </p>
          ))}
          {message.stopped && (
            <p className="mt-2 text-[10px] italic text-destructive opacity-80">
              Message stopped by user
            </p>
          )}
        </div>
        <p className={`mt-1.5 text-[10px] text-muted-foreground ${isUser ? 'text-right' : ''}`}>{timeLabel}</p>
      </div>
    </div>
  );
}

function DemoSupportConversations() {
  const { accounts, accountsStatus, accountsError } = useHqData();

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background px-4 py-6 md:px-8 md:py-8" data-testid="support-conversations-view">
      <div className="mx-auto max-w-4xl">
        <header>
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Support</p>
          <h1 className="mt-1 font-serif text-[26px] font-bold leading-tight text-navy">Conversations</h1>
          <p className="mt-1.5 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
            Support conversations and provider contact/status context only.
          </p>
        </header>

        <section className="mt-6 rounded-lg border border-card-border bg-card p-5 shadow-soft" aria-live="polite">
          <MessagesSquare size={20} className="text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 font-serif text-lg font-bold text-navy">No support conversations available</h2>
          <p className="mt-1 max-w-[66ch] text-xs leading-relaxed text-muted-foreground" data-testid="status-support-conversations-unavailable">
            Support conversation history is not connected to a server-backed source. Clinical coach demo transcripts are
            intentionally not shown in this workspace.
          </p>
        </section>

        <section className="mt-5 overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-serif text-base font-bold text-navy">Provider contact and status</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">Live provider directory fields available to Support.</p>
          </div>
          {accountsStatus === 'loading' && (
            <p className="px-5 py-6 text-xs text-muted-foreground" role="status">Loading provider contacts…</p>
          )}
          {accountsStatus === 'error' && (
            <p className="px-5 py-6 text-xs text-destructive" role="alert">
              {accountsError ?? 'Provider contacts could not be loaded.'}
            </p>
          )}
          {accountsStatus !== 'loading' && accountsStatus !== 'error' && accounts.length === 0 && (
            <p className="px-5 py-6 text-xs text-muted-foreground">No live provider contacts are available.</p>
          )}
          {accounts.length > 0 && (
            <ul className="divide-y divide-border/60" aria-label="Provider contact and status">
              {accounts.map((account) => (
                <li key={account.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-navy">{account.officeName}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{account.providerName}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {account.email}{account.phone ? ` · ${account.phone}` : ''}
                    </p>
                  </div>
                  <AccountStatusChip status={account.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function DemoClinicalConversations({ role }: { role: 'Super Admin' | 'Admin' | 'Clinical' }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { accounts, findAccount } = useHqData();

  const params = new URLSearchParams(search);
  const rawAccount = params.get('account');
  // Unknown ids (stale links) fall back to the all-accounts view.
  const accountFilter = rawAccount && findAccount(rawAccount) ? rawAccount : 'all';
  const openId = params.get('c');
  const query = params.get('q') ?? '';

  /** Current view re-encoded with overrides; null/'all' clear their param. */
  const buildUrl = (next: { account?: string; c?: string | null; q?: string }) => {
    const url = new URLSearchParams();
    const account = next.account !== undefined ? next.account : accountFilter;
    const conversation = next.c !== undefined ? next.c : openId;
    const term = next.q !== undefined ? next.q : query;
    if (account !== 'all') url.set('account', account);
    if (conversation) url.set('c', conversation);
    if (term) url.set('q', term);
    const encoded = url.toString();
    return encoded ? `/admin/conversations?${encoded}` : '/admin/conversations';
  };

  // Threads in scope of the account filter, newest activity first, with the
  // patient and account each row renders and searches against.
  const accountRows = useMemo<RailRow[]>(
    () =>
       getConversationsForRole(role, accountFilter === 'all' ? undefined : accountFilter).map((conv) => ({
        conv,
        patient: MOCK_PATIENTS.find((patient) => patient.id === conv.patientId),
        account: findAccount(conv.accountId),
      })),
    [accountFilter, findAccount, role],
  );

  const visibleRows = useMemo(
    () => accountRows.filter((row) => conversationMatchesQuery(searchFieldsOf(row), query)),
    [accountRows, query],
  );

  // An explicitly opened thread stays open even while a search narrows the
  // rail past it (iMessage behavior). Desktop otherwise previews the first
  // visible thread; mobile shows the transcript only after a tap.
  const explicit = openId ? accountRows.find((row) => row.conv.id === openId) : undefined;
  const selected = explicit ?? visibleRows[0];

  const setAccountFilter = (next: string) =>
    // Changing accounts drops the open thread — it may not belong to the new
    // filter — but keeps the search term (the two narrow independently).
    navigate(buildUrl({ account: next, c: null }), { replace: true });
  const setQuery = (next: string) => navigate(buildUrl({ q: next }), { replace: true });
  const openConversation = (id: string) => navigate(buildUrl({ c: id }));
  const closeThread = () => navigate(buildUrl({ c: null }), { replace: true });

  const listPane = (
    <aside
      className={`${explicit ? 'hidden md:flex' : 'flex'} w-full min-w-0 flex-col border-r border-border bg-paper-alt md:w-[320px] md:shrink-0 lg:w-[352px]`}
    >
      <div className="shrink-0 space-y-2.5 border-b border-border px-4 pb-3.5 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Coach</p>
            <h1 className="font-serif text-lg font-bold leading-tight tracking-[-.01em] text-navy">Conversations</h1>
          </div>
          <span aria-live="polite" className="shrink-0 text-[10px] tabular-nums text-muted-foreground" data-testid="text-conversation-count">
            {visibleRows.length === accountRows.length ? accountRows.length : `${visibleRows.length} of ${accountRows.length}`}
            <span className="sr-only"> conversations shown</span>
          </span>
        </div>

        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search patients, offices, providers"
            aria-label="Search conversations by patient name, email, phone, office, provider, or code"
            autoComplete="off"
            data-testid="input-conversation-search"
            className="h-9 w-full rounded-md border border-border bg-card pl-8 pr-8 text-xs text-foreground shadow-xs outline-none placeholder:text-muted-foreground/80 focus:ring-2 focus:ring-ring"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              data-testid="button-clear-search"
              className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        <Select value={accountFilter} onValueChange={setAccountFilter}>
          <SelectTrigger
            className="h-9 w-full text-xs"
            aria-label="Filter by provider account"
            data-testid="select-conversation-account"
          >
            <SelectValue>
              {accountFilter === 'all' ? 'All provider accounts' : findAccount(accountFilter)?.officeName}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
               All provider accounts ({getConversationsForRole(role).length})
            </SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id} className="text-xs">
                {/* Office, provider, and code all identify the account. */}
                <span className="block">
                   {account.officeName} ({getConversationsForRole(role, account.id).length})
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {account.providerName} · Code {account.providerCode}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length > 0 ? (
          <ul aria-label="Coach conversations" className="divide-y divide-border/60">
            {visibleRows.map((row) => {
              const isActive = selected?.conv.id === row.conv.id;
              return (
                <li key={row.conv.id}>
                  <button
                    type="button"
                    data-testid={`item-conversation-${row.conv.id}`}
                    onClick={() => openConversation(row.conv.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`flex w-full items-start gap-3 border-l-2 px-3.5 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                      isActive ? 'border-primary bg-card shadow-soft' : 'border-transparent hover:bg-card/70'
                    }`}
                  >
                    <PatientAvatar patient={row.patient} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <b className="truncate text-xs font-semibold text-navy">{row.patient?.name ?? 'Patient'}</b>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {row.conv.lastActivityLabel}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                        {row.conv.preview}
                      </span>
                      <span className="mt-1 block truncate text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground/70">
                        {row.account?.officeName ?? 'Unknown office'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-5 py-10 text-center" data-testid="empty-conversations">
            <MessagesSquare size={18} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-semibold text-navy">No conversations found</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {query
                ? <>Nothing matches &ldquo;{query}&rdquo;{accountFilter !== 'all' ? ' in this account' : ''}. Try a patient name, email, or phone — or an office, provider, or code.</>
                : 'No transcripts for this account yet.'}
            </p>
            {query && (
              <button type="button" onClick={() => setQuery('')} className={`${BTN_SECONDARY} mt-3 h-8 px-3 text-[11px]`} data-testid="button-empty-clear-search">
                Clear search
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );

  const viewerPane = (
    <section className={`${explicit ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-background`}>
      {selected ? (
        <>
          <header className="shrink-0 border-b border-border bg-card px-4 py-3 md:px-6">
            {explicit && (
              <button
                type="button"
                className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                onClick={closeThread}
                data-testid="button-back-to-conversations"
              >
                <ArrowLeft size={12} aria-hidden="true" />
                All conversations
              </button>
            )}
            <div className="flex items-center gap-3">
              <PatientAvatar patient={selected.patient} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <h2 className="truncate font-serif text-base font-bold tracking-[.01em] text-navy" data-testid="text-conversation-patient">
                    {selected.patient?.name ?? 'Patient'}
                  </h2>
                  <span className={CHIP_WARM}>Mock transcript</span>
                </div>
                {selected.patient && (
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground" data-testid="text-conversation-contact">
                    {selected.patient.email} · {selected.patient.phone}
                  </p>
                )}
                <p
                  className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground/80"
                  data-testid="text-conversation-office"
                >
                  {selected.account
                    ? `${selected.account.officeName} · ${selected.account.providerName} · Code ${selected.account.providerCode}`
                    : 'Unknown office'}
                </p>
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
            <div className="mx-auto w-full max-w-[820px] space-y-4">
              <p className="text-center text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground/80">
                {selected.conv.topic} · Started {selected.conv.startedLabel}
              </p>
               {getConversationMessagesForRole(role, selected.conv.id).map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
            </div>
          </div>

          <footer className="shrink-0 border-t border-border bg-card px-4 py-2.5 md:px-6">
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Read-only transcript imitating the mobile coach thread — cards and one-tap replies render as the patient saw
              them on the phone. See the phone for the live experience.
            </p>
          </footer>
        </>
      ) : (
        <div className="grid flex-1 place-items-center px-6 py-10">
          <div className="text-center">
            <MessagesSquare size={20} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs text-muted-foreground">
              {accountRows.length === 0 ? 'No transcripts for this account yet.' : 'Select a conversation to read it.'}
            </p>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className="flex h-full min-h-0">
      {listPane}
      {viewerPane}
    </div>
  );
}

function LiveConversations({ role }: { role: HqRole }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { accounts, findAccount } = useHqData();
  const { authUser } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const params = new URLSearchParams(search);
  const rawOffice = params.get('office') ?? params.get('account');
  const accountFilter = rawOffice && findAccount(rawOffice) ? rawOffice : 'all';
  const openId = params.get('conversation') ?? params.get('c');
  const threadFilter = (params.get('thread') === 'support' || (!params.has('thread') && role === 'Support') ? 'support' : 'coach') as GetOfficeConversationsThread;
  const statusFilter = params.get('status') as GetOfficeConversationsStatus | null;
  const assigneeFilter = params.get('assignee') ?? 'anyone';
  const unreadOnly = params.get('unread') === 'true';
  const sortFilter = (params.get('sort') ?? 'newest') as GetOfficeConversationsSort;
  const queryFilter = params.get('q') ?? '';

  const isUnifiedAdmin = role === 'Super Admin' || role === 'Admin';
  const [searchText, setSearchText] = useState(queryFilter);
  const [offset, setOffset] = useState(0);
  const limit = 20;
  const updateUrl = (changes: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(search);
    next.delete('account'); next.delete('c');
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    navigate(`/admin/conversations${next.toString() ? `?${next}` : ''}`, { replace });
  };

  const setAccountFilter = (next: string) => {
    setOffset(0);
    updateUrl({ office: next === 'all' ? null : next, conversation: null });
  };

  const handleThreadChange = (next: GetOfficeConversationsThread) => {
    setOffset(0);
    updateUrl({ thread: next, conversation: null });
  };

  const openConversation = (id: string) => updateUrl({ conversation: id }, false);
  const closeThread = () => updateUrl({ conversation: null });

  useEffect(() => {
    setSearchText(queryFilter);
  }, [queryFilter]);
  useEffect(() => {
    if (searchText === queryFilter) return;
    const timer = window.setTimeout(() => { setOffset(0); updateUrl({ q: searchText.trim() || null, conversation: null }); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText, queryFilter]);

  const resolvedOffice = accountFilter !== 'all' ? accountFilter : undefined;
  const listParams = {
    office: resolvedOffice, thread: threadFilter,
    status: statusFilter ?? undefined,
    assignee: assigneeFilter === 'anyone' ? undefined : assigneeFilter,
    unread: unreadOnly || undefined, q: queryFilter || undefined,
    sort: sortFilter, limit, offset,
  };

  const { data: convData, isFetching: isConvFetching, error: convError } = useGetOfficeConversations(
    listParams,
    {
      query: {
        enabled: !!resolvedOffice,
        queryKey: [...getGetOfficeConversationsQueryKey(listParams), authUser?.id],
      }
    }
  );
  const summary = useGetOfficeConversationSummary({ office: resolvedOffice }, { query: { enabled: !!resolvedOffice, queryKey: getGetOfficeConversationSummaryQueryKey({ office: resolvedOffice }) } });
  const staff = useGetOfficeConversationStaff({ office: resolvedOffice }, { query: { enabled: !!resolvedOffice, queryKey: getGetOfficeConversationStaffQueryKey({ office: resolvedOffice }) } });

  const conversations = convData?.conversations ?? [];
  const total = convData?.total ?? 0;
  const autoCloseDays = convData?.autoCloseDays;
  const hasMore = offset + limit < total;
  const hasPrev = offset > 0;

  const [beforeCursor, setBeforeCursor] = useState<number | undefined>(undefined);
  const [allEvents, setAllEvents] = useState<ConversationEvent[]>([]);

  useEffect(() => {
    setBeforeCursor(undefined);
    setAllEvents([]);
  }, [openId, accountFilter, threadFilter, statusFilter]);

  const { data: eventsData, isFetching: isEventsFetching, error: eventsError } = useGetOfficeConversationEvents(
    openId ?? '',
    { office: resolvedOffice, before: beforeCursor, limit: 30 },
    {
      query: {
        enabled: !!openId && !!resolvedOffice,
        queryKey: [...getGetOfficeConversationEventsQueryKey(openId ?? '', { office: resolvedOffice, before: beforeCursor, limit: 30 }), authUser?.id],
      }
    }
  );

  useEffect(() => {
    if (eventsData?.events) {
      setAllEvents(prev => {
        const newEvents = eventsData.events.filter(e => !prev.some(p => p.seq === e.seq));
        return [...prev, ...newEvents].sort((a, b) => a.seq - b.seq);
      });
      if (beforeCursor === undefined) queryClient.invalidateQueries({ queryKey: ['/api/office/conversations'] });
    }
  }, [eventsData?.events]);

  const explicit = openId;
  const selectedSummary = eventsData?.conversation ?? conversations.find(c => c.id === openId);
  const notes = useGetOfficeConversationNotes(openId ?? '', { office: resolvedOffice }, { query: { enabled: !!openId && !!resolvedOffice, queryKey: getGetOfficeConversationNotesQueryKey(openId ?? '', { office: resolvedOffice }) } });
  const assign = useAssignOfficeConversation();
  const setStatus = useSetOfficeConversationStatus();
  const reply = useReplyOfficeConversation();
  const addNote = useAddOfficeConversationNote();
  const escalate = useEscalateOfficeConversation();
  const [replyText, setReplyText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [escalationOpen, setEscalationOpen] = useState(false);
  const [department, setDepartment] = useState<'clinical' | 'support'>('clinical');
  const [reason, setReason] = useState('');
  const [escalationError, setEscalationError] = useState<string | null>(null);

  const refresh = async (includeEvents = false) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['/api/office/conversations'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/office/conversations/summary'] }),
      ...(includeEvents && openId ? [queryClient.invalidateQueries({ queryKey: [`/api/office/conversations/${openId}/events`] })] : []),
    ]);
  };
  const mutationError = (title: string, error: unknown) => {
    const status = (error as { status?: number })?.status;
    toast({ variant: 'destructive', title, description: status === 403 ? 'You do not have permission to perform this action.' : error instanceof Error ? error.message : 'Try again.' });
  };
  const changeAssignment = async (assigneeUserId: string | null) => {
    if (!openId) return;
    try { await assign.mutateAsync({ conversationId: openId, data: { assigneeUserId }, params: { office: resolvedOffice } }); await refresh(); toast({ variant: 'success', title: assigneeUserId === 'me' ? 'Conversation claimed' : 'Assignment updated' }); }
    catch (e) { mutationError('Assignment not updated', e); }
  };
  const changeStatus = async (status: 'open' | 'waiting_patient' | 'closed') => {
    if (!openId) return;
    try { await setStatus.mutateAsync({ conversationId: openId, data: { status }, params: { office: resolvedOffice } }); await refresh(); toast({ variant: 'success', title: status === 'open' ? 'Conversation reopened' : 'Status updated' }); }
    catch (e) { mutationError('Status not updated', e); }
  };
  const sendReply = async () => {
    if (!openId || !replyText.trim()) return;
    try {
      const result = await reply.mutateAsync({ conversationId: openId, data: { text: replyText.trim() }, params: { office: resolvedOffice } });
      setAllEvents(prev => [...prev.filter(e => e.seq !== result.event.seq), result.event].sort((a, b) => a.seq - b.seq));
      setReplyText(''); await refresh(true); toast({ variant: 'success', title: 'Reply sent' });
    } catch (e) { mutationError('Reply not sent', e); }
  };
  const saveNote = async () => {
    if (!openId || !noteText.trim()) return;
    try { await addNote.mutateAsync({ conversationId: openId, data: { body: noteText.trim() }, params: { office: resolvedOffice } }); setNoteText(''); await queryClient.invalidateQueries({ queryKey: getGetOfficeConversationNotesQueryKey(openId, { office: resolvedOffice }) }); await refresh(); toast({ variant: 'success', title: 'Internal note added' }); }
    catch (e) { mutationError('Note not added', e); }
  };
  const submitEscalation = async () => {
    if (!openId || !reason.trim()) return;
    setEscalationError(null);
    try { await escalate.mutateAsync({ conversationId: openId, data: { department, reason: reason.trim() }, params: { office: resolvedOffice } }); setEscalationOpen(false); setReason(''); await refresh(); toast({ variant: 'success', title: 'Conversation escalated' }); }
    catch (e) { if ((e as { status?: number })?.status === 409) setEscalationError('This conversation is already escalated.'); else mutationError('Conversation not escalated', e); }
  };
  const avgLabel = (minutes: number | null | undefined) => minutes == null ? '—' : minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`;

  const listPane = (
    <aside
      className={`${explicit ? 'hidden lg:flex' : 'flex'} w-full min-w-0 flex-col border-r border-border bg-paper-alt lg:w-[410px] lg:shrink-0`}
    >
      <div className="shrink-0 space-y-2.5 border-b border-border px-4 pb-3.5 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">{threadFilter === 'support' ? 'Support' : 'Coach'}</p>
            <h1 className="font-serif text-lg font-bold leading-tight tracking-[-.01em] text-navy">Live Conversations</h1>
          </div>
          {total > 0 && (
            <span aria-live="polite" className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
          )}
        </div>

        {isUnifiedAdmin && (
          <div className="flex rounded-md bg-muted p-1">
            <button
              onClick={() => handleThreadChange('coach')}
              className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${threadFilter === 'coach' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Coach
            </button>
            <button
              onClick={() => handleThreadChange('support')}
              className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${threadFilter === 'support' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Support
            </button>
          </div>
        )}

        <Select value={accountFilter} onValueChange={setAccountFilter}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue>{accountFilter === 'all' ? 'Select a provider account...' : findAccount(accountFilter)?.officeName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
               Select a provider account...
            </SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id} className="text-xs">
                <span className="block">{account.officeName}</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {account.providerName} · Code {account.providerCode}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {resolvedOffice && (
          <>
            {summary.isPending ? <p className="text-[11px] text-muted-foreground">Loading inbox metrics…</p> :
             summary.isError ? <p role="alert" className="text-[11px] text-destructive">Inbox metrics could not be loaded.</p> :
             <div className="grid grid-cols-5 gap-1" aria-label="Inbox metrics">
               {[
                 ['Open', summary.data?.metrics.openThreads],
                 ['Waiting', summary.data?.metrics.waitingOnPatient],
                 ['Unanswered', summary.data?.metrics.unanswered],
                 ['Avg response', avgLabel(summary.data?.metrics.avgResponseMinutes)],
                 ['Escalated', summary.data?.metrics.openEscalations],
               ].map(([label, value]) => <div key={label} className="rounded-md border border-card-border bg-card p-1.5 text-center"><b className="block font-serif text-sm text-navy">{value}</b><span className="text-[8px] uppercase text-muted-foreground">{label}</span></div>)}
             </div>}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2.5 text-muted-foreground" />
              <input aria-label="Search conversations" value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Search patient or messages" className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={statusFilter ?? 'all'} onValueChange={value => { setOffset(0); updateUrl({ status: value === 'all' ? null : value, conversation: null }); }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">Any status</SelectItem><SelectItem value="open">Open</SelectItem><SelectItem value="waiting_patient">Waiting on patient</SelectItem><SelectItem value="closed">Closed</SelectItem></SelectContent>
              </Select>
              <Select value={assigneeFilter} onValueChange={value => { setOffset(0); updateUrl({ assignee: value === 'anyone' ? null : value, conversation: null }); }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="anyone">Anyone</SelectItem><SelectItem value="me">Mine</SelectItem><SelectItem value="unassigned">Unassigned</SelectItem>{staff.data?.staff.map(person => <SelectItem key={person.userId} value={person.userId}>{person.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={sortFilter} onValueChange={value => { setOffset(0); updateUrl({ sort: value === 'newest' ? null : value, conversation: null }); }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="newest">Newest</SelectItem><SelectItem value="oldest">Oldest</SelectItem><SelectItem value="waiting_longest">Waiting longest</SelectItem><SelectItem value="unread_first">Unread first</SelectItem></SelectContent>
              </Select>
              <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-xs"><input type="checkbox" checked={unreadOnly} onChange={e => { setOffset(0); updateUrl({ unread: e.target.checked ? 'true' : null, conversation: null }); }} /> Unread only</label>
            </div>
            {autoCloseDays !== undefined && (
              <p className="text-[10px] text-muted-foreground" data-testid="text-auto-close-window">
                Closes after {autoCloseDays}d quiet · set in HQ organization policies
              </p>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!resolvedOffice ? (
          <div className="px-5 py-10 text-center">
            <MessagesSquare size={18} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-semibold text-navy">Select an account</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              You must select a provider account to view live {threadFilter} conversations.
            </p>
          </div>
        ) : isConvFetching && conversations.length === 0 ? (
          <div className="px-5 py-10 text-center text-xs text-muted-foreground">Loading...</div>
        ) : convError ? (
          <div className="px-5 py-10 text-center text-xs text-destructive">Failed to load conversations.</div>
        ) : conversations.length > 0 ? (
          <div className="flex flex-col h-full">
            <ul className="divide-y divide-border/60 flex-1">
              {conversations.map((conv) => {
                const isActive = openId === conv.id;
                return (
                  <li key={conv.id}>
                     <Link
                       href={`/admin/conversations?${new URLSearchParams({ ...(resolvedOffice ? { office: resolvedOffice } : {}), thread: threadFilter, conversation: conv.id }).toString()}`}
                       onClick={(event) => { event.preventDefault(); openConversation(conv.id); }}
                      className={`flex w-full items-start gap-3 border-l-2 px-3.5 py-3 text-left transition ${isActive ? 'border-primary bg-card shadow-soft' : 'border-transparent hover:bg-card/70'}`}
                    >
                       {conv.unread && <span className="mt-4 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread conversation" />}
                      <InitialsAvatar name={conv.patientName} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                           <b className={`truncate text-xs text-navy ${conv.unread ? 'font-bold' : 'font-semibold'}`}>{conv.patientName}</b>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {conv.lastMessageAt ? formatRelativeTime(conv.lastMessageAt) : ''}
                          </span>
                        </span>
                         <span className="mt-1 flex flex-wrap gap-1 text-[9px] font-semibold uppercase"><span className={CHIP_WARM}>{conv.thread}</span><span className="rounded bg-secondary px-1.5 py-0.5" data-testid={conv.autoClosed ? `chip-conversation-auto-closed-${conv.id}` : undefined}>{conv.autoClosed ? 'closed · quiet' : conv.status.replace('_', ' ')}</span>{conv.openEscalation && <span className="rounded bg-warn-bg px-1.5 py-0.5 text-warn">Escalated · {conv.openEscalation.department}</span>}</span>
                         <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{conv.preview || `${conv.messageCount} messages`}</span>
                         <span className="mt-1 flex gap-2 text-[10px] text-muted-foreground"><span>{conv.assignee?.label ?? 'Unassigned'}</span>{conv.noteCount > 0 && <span>{conv.noteCount} note{conv.noteCount === 1 ? '' : 's'}</span>}</span>
                      </span>
                     </Link>
                  </li>
                );
              })}
            </ul>
            {(hasPrev || hasMore) && (
              <div className="flex justify-between items-center px-4 py-3 border-t border-border">
                <button
                  disabled={!hasPrev || isConvFetching}
                  onClick={() => setOffset(o => Math.max(0, o - limit))}
                  className={`${BTN_SECONDARY} h-7 px-3 text-[10px]`}
                >
                  Newer
                </button>
                <button
                  disabled={!hasMore || isConvFetching}
                  onClick={() => setOffset(o => o + limit)}
                  className={`${BTN_SECONDARY} h-7 px-3 text-[10px]`}
                >
                  Older
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <MessagesSquare size={18} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-semibold text-navy">No conversations</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {statusFilter === 'open'
                ? `No open ${threadFilter} conversations match. Threads quiet for ${autoCloseDays ?? 'the auto-close'} days are filed under Closed.`
                : statusFilter === 'closed'
                  ? `No closed ${threadFilter} conversations match yet.`
                  : `No live ${threadFilter} conversations match yet.`}
            </p>
          </div>
        )}
      </div>
    </aside>
  );

  const viewerPane = (
    <section className={`${explicit ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-background`}>
      {openId ? (
        <>
          <header className="shrink-0 border-b border-border bg-card px-4 py-3 md:px-6">
            {explicit && (
              <button
                type="button"
                className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline md:hidden"
                onClick={closeThread}
              >
                <ArrowLeft size={12} aria-hidden="true" />
                All conversations
              </button>
            )}
            <div className="flex items-center gap-3">
              <InitialsAvatar name={selectedSummary?.patientName ?? 'Patient'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <h2 className="truncate font-serif text-base font-bold tracking-[.01em] text-navy">
                    {selectedSummary?.patientName ?? 'Patient'}
                  </h2>
                  <span className={CHIP_WARM}>Live transcript</span>
                </div>
                <p className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground/80">
                  {findAccount(accountFilter)?.officeName ?? 'Unknown office'}
                </p>
              </div>
            </div>
          </header>
           {selectedSummary && (
             <div className="flex flex-wrap items-center gap-2 border-b border-border bg-paper-alt px-4 py-2 md:px-6">
               <button className={`${BTN_SECONDARY} h-8 px-3 text-xs`} disabled={assign.isPending} onClick={() => changeAssignment('me')}>Claim</button>
               <Select value={selectedSummary.assignee?.userId ?? 'unassigned'} onValueChange={value => changeAssignment(value === 'unassigned' ? null : value)}>
                 <SelectTrigger aria-label="Assign conversation" className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                 <SelectContent><SelectItem value="unassigned">Unassign</SelectItem>{staff.data?.staff.map(person => <SelectItem key={person.userId} value={person.userId}>{person.label}</SelectItem>)}</SelectContent>
               </Select>
               <div className="flex rounded-md bg-muted p-1" aria-label="Conversation status">
                 {selectedSummary.status === 'closed' ? (
                   <>
                     {selectedSummary.autoClosed && <span className="self-center px-2 text-[10px] text-muted-foreground">Closed after {autoCloseDays ?? '—'}d quiet</span>}
                     <button className="rounded-sm bg-card px-3 py-1 text-xs font-semibold" disabled={setStatus.isPending} onClick={() => changeStatus('open')}>Reopen</button>
                   </>
                 ) : <>
                   {([['open', 'Open'], ['waiting_patient', 'Waiting on patient'], ['closed', 'Closed']] as const).map(([value, label]) => (
                     <button key={value} disabled={setStatus.isPending} onClick={() => changeStatus(value)} className={`rounded-sm px-2 py-1 text-[10px] font-semibold ${selectedSummary.status === value ? 'bg-card text-navy shadow-xs' : 'text-muted-foreground'}`}>{label}</button>
                   ))}
                 </>}
               </div>
               <button className={`${BTN_SECONDARY} ml-auto h-8 px-3 text-xs`} disabled={!!selectedSummary.openEscalation} onClick={() => setEscalationOpen(true)}><AlertTriangle size={12} /> {selectedSummary.openEscalation ? 'Escalated' : 'Escalate'}</button>
             </div>
           )}

           <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
             <div className="mx-auto grid w-full max-w-[1050px] gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
             <div className="space-y-4 flex flex-col justify-end">
              {eventsData?.nextBefore && (
                <div className="text-center pb-4">
                  <button
                    onClick={() => setBeforeCursor(eventsData.nextBefore!)}
                    disabled={isEventsFetching}
                    className={`${BTN_SECONDARY} h-8 px-4 text-xs`}
                  >
                    {isEventsFetching ? 'Loading...' : 'Load older messages'}
                  </button>
                </div>
              )}
              {isEventsFetching && allEvents.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-10">Loading messages...</div>
              ) : eventsError ? (
                <div className="text-center text-xs text-destructive py-10">Failed to load messages.</div>
              ) : allEvents.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-10">No messages in this conversation.</div>
              ) : (
                <>
                  <p className="text-center text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground/80 mb-2">
                    Started {selectedSummary?.createdAt ? formatRelativeTime(selectedSummary.createdAt) : ''}
                  </p>
                  {allEvents.map((message) => (
                    <LiveMessageRow key={message.seq} message={message} />
                  ))}
                </>
              )}
            </div>
             <aside className="rounded-lg border border-card-border bg-card p-4 shadow-soft">
               <div className="flex items-center gap-2"><StickyNote size={14} className="text-primary" /><h3 className="font-serif text-sm font-bold text-navy">Internal notes</h3></div>
               <p className="mt-1 text-[10px] font-semibold text-warn">Internal — patients never see notes</p>
               {notes.isError ? <p role="alert" className="mt-3 text-xs text-destructive">Notes could not be loaded.</p> :
                <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">{notes.data?.notes.map(note => <li key={note.id} className="rounded-md bg-paper-alt p-2 text-xs"><p>{note.body}</p><p className="mt-1 text-[9px] text-muted-foreground">{note.authorLabel} · {formatRelativeTime(note.createdAt)}</p></li>)}</ul>}
               <textarea aria-label="New internal note" value={noteText} onChange={e => setNoteText(e.target.value)} maxLength={4000} rows={3} className="mt-3 w-full rounded-md border border-input bg-background p-2 text-xs" />
               <button className={`${BTN_SECONDARY} mt-2 h-8 px-3 text-xs`} disabled={addNote.isPending || !noteText.trim()} onClick={saveNote}>{addNote.isPending ? 'Adding…' : 'Add note'}</button>
             </aside>
             </div>
          </div>

           <footer className="shrink-0 border-t border-border bg-card px-4 py-3 md:px-6">
             <div className="mx-auto flex max-w-[1050px] gap-2">
               <textarea aria-label="Reply to patient" value={replyText} onChange={e => setReplyText(e.target.value)} maxLength={4000} rows={2} placeholder="Write a care-team reply…" className="min-w-0 flex-1 rounded-md border border-input bg-background p-2 text-xs" />
               <button className="rounded-md bg-primary px-4 text-xs font-bold text-primary-foreground disabled:opacity-50" disabled={reply.isPending || !replyText.trim()} onClick={sendReply}>{reply.isPending ? 'Sending…' : 'Send'}</button>
             </div>
          </footer>
        </>
      ) : (
        <div className="grid flex-1 place-items-center px-6 py-10">
          <div className="text-center">
            <MessagesSquare size={20} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs text-muted-foreground">
              Select a conversation to read it.
            </p>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className="flex h-full min-h-0">
      {listPane}
      {viewerPane}
       <Dialog open={escalationOpen} onOpenChange={setEscalationOpen}>
         <DialogContent>
           <DialogHeader><DialogTitle>Escalate to HQ</DialogTitle><DialogDescription>Send this conversation to the appropriate HQ queue.</DialogDescription></DialogHeader>
           <fieldset className="flex gap-4 text-sm"><legend className="sr-only">Department</legend><label><input type="radio" checked={department === 'clinical'} onChange={() => setDepartment('clinical')} /> Clinical</label><label><input type="radio" checked={department === 'support'} onChange={() => setDepartment('support')} /> Support</label></fieldset>
           <textarea aria-label="Escalation reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} rows={5} className="w-full rounded-md border border-input p-3 text-sm" placeholder="Reason for escalation" />
           {escalationError && <p role="alert" className="text-sm text-destructive">{escalationError}</p>}
           <DialogFooter><button className={BTN_SECONDARY} onClick={() => setEscalationOpen(false)}>Cancel</button><button className="rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50" disabled={escalate.isPending || !reason.trim()} onClick={submitEscalation}>{escalate.isPending ? 'Escalating…' : 'Escalate'}</button></DialogFooter>
         </DialogContent>
       </Dialog>
    </div>
  );
}

export default function Conversations() {
  const { authStatus, hqRole } = useSession();
  const effectiveRole = authStatus === 'signed-out' ? 'Super Admin' : hqRole;

  if (authStatus === 'signed-in') {
    return <LiveConversations role={effectiveRole!} />;
  }

  if (effectiveRole === 'Support') return <DemoSupportConversations />;
  if (effectiveRole === 'Super Admin' || effectiveRole === 'Admin' || effectiveRole === 'Clinical') {
    return <DemoClinicalConversations role={effectiveRole} />;
  }
  return null;
}
