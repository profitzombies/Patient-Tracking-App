/**
 * Cross-account coach conversations viewer — an iMessage-style two-pane
 * messenger in the Heritage skin.
 *
 * Left rail: searchable, filterable list of every mock thread, newest
 * activity first (each thread's latest message, not its start date), with
 * avatar / name / last-message preview / time rows. Right pane: the selected
 * transcript rendered the way the mobile coach chat shows it — user bubbles
 * right, coach bubbles left in blank-line-separated blocks, rich cards
 * (recipe / product) under the reply that offered them, and the one-tap
 * reply chips the patient saw. Everything is read-only — the chips and card
 * buttons are display artifacts of the phone UI, not live controls here,
 * and there is deliberately no composer.
 *
 * URL contract: ?account=<id> filters to one provider account (the account
 * detail page links here with it), ?c=<conversation id> opens a specific
 * thread, and ?q=<text> carries the rail search — all three survive reload
 * and sharing. On phones the rail shows first; opening a thread goes
 * full-screen with a back control.
 */
import { useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ArrowLeft, MessagesSquare, Search, X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN_SECONDARY, CHIP_WARM, WARM_TEXT } from '@/components/patient/heritage';
import { useHqData } from '@/contexts/hq-data';
import { MOCK_PATIENTS, MOCK_PRODUCTS, type Patient } from '@/data/mock-data';
import type { ProviderAccount } from '@/data/hq/accounts';
import {
  HQ_CONVERSATION_MESSAGES,
  conversationMatchesQuery,
  getConversations,
  type ConversationSearchFields,
  type HqCoachMessage,
  type HqConversationSummary,
  type HqRecipePayload,
} from '@/data/hq/conversations';

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
  providerCode: account?.providerCode,
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

export default function Conversations() {
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
      getConversations(accountFilter === 'all' ? undefined : accountFilter).map((conv) => ({
        conv,
        patient: MOCK_PATIENTS.find((patient) => patient.id === conv.patientId),
        account: findAccount(conv.accountId),
      })),
    [accountFilter, findAccount],
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
              All provider accounts ({getConversations().length})
            </SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id} className="text-xs">
                {/* Office, provider, and code all identify the account. */}
                <span className="block">
                  {account.officeName} ({getConversations(account.id).length})
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
              {(HQ_CONVERSATION_MESSAGES[selected.conv.id] ?? []).map((message) => (
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
