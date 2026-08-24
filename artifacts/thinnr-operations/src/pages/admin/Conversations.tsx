/**
 * Cross-account coach conversations viewer.
 *
 * Browses the mock transcripts seeded per provider account and renders them
 * the way the mobile coach chat does: user bubbles right, coach bubbles left
 * in blank-line-separated blocks, rich cards (recipe / product) under the
 * reply that offered them, and the one-tap reply chips the patient saw.
 * Everything is read-only — the chips and card buttons are display artifacts
 * of the phone UI, not live controls here.
 *
 * URL contract: ?account=<id> filters to one provider account (the account
 * detail page links here with it) and ?c=<conversation id> opens a specific
 * thread — both survive reload and sharing.
 */
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, MessagesSquare } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHIP_WARM, PANEL_LABEL, WARM_TEXT } from '@/components/patient/heritage';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { MOCK_PATIENTS, MOCK_PRODUCTS } from '@/data/mock-data';
import {
  HQ_CONVERSATION_MESSAGES,
  getConversations,
  type HqCoachMessage,
  type HqConversation,
  type HqRecipePayload,
} from '@/data/hq/conversations';

/** Roster lookup — transcripts reference seeded patients, never name copies. */
const patientNameOf = (patientId: string) =>
  MOCK_PATIENTS.find((patient) => patient.id === patientId)?.name ?? 'Patient';

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

  const conversations = getConversations(accountFilter === 'all' ? undefined : accountFilter);
  const explicit = openId ? conversations.find((conv) => conv.id === openId) : undefined;
  // Desktop always shows a thread (first of the list); mobile only after a tap.
  const selected = explicit ?? conversations[0];

  const setFilter = (next: string) => {
    // Changing accounts drops the open thread — it may not belong to the new filter.
    navigate(next === 'all' ? '/admin/conversations' : `/admin/conversations?account=${next}`, { replace: true });
  };

  const openConversation = (conv: HqConversation) => {
    const query = new URLSearchParams();
    if (accountFilter !== 'all') query.set('account', accountFilter);
    query.set('c', conv.id);
    navigate(`/admin/conversations?${query.toString()}`);
  };

  const listPane = (
    <div className={`${explicit ? 'hidden md:block' : ''} min-w-0`}>
      <div className="space-y-2" role="list" aria-label="Coach conversations">
        {conversations.map((conv) => {
          const isActive = selected?.id === conv.id;
          const account = findAccount(conv.accountId);
          return (
            <button
              key={conv.id}
              type="button"
              role="listitem"
              data-testid={`item-conversation-${conv.id}`}
              onClick={() => openConversation(conv)}
              className={`w-full rounded-md border-l-2 px-3.5 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActive
                  ? 'border-primary bg-card shadow-soft'
                  : 'border-transparent bg-paper-alt hover:bg-card hover:shadow-xs'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <b className="truncate text-xs font-semibold text-navy">{patientNameOf(conv.patientId)}</b>
                <span className="shrink-0 text-[10px] text-muted-foreground">{conv.startedLabel}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{conv.topic}</p>
              <p className="mt-1 text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground/80">
                {account?.officeName ?? 'Unknown office'}
              </p>
            </button>
          );
        })}
        {conversations.length === 0 && (
          <div className="rounded-md border border-border bg-paper-alt px-4 py-8 text-center">
            <MessagesSquare size={18} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs text-muted-foreground">No transcripts for this account yet.</p>
          </div>
        )}
      </div>
    </div>
  );

  const viewerAccount = selected ? findAccount(selected.accountId) : undefined;

  const viewerPane = (
    <div className={`${explicit ? '' : 'hidden md:block'} min-w-0`}>
      {selected ? (
        <section className="overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
          <div className="border-b border-border px-5 py-4">
            {explicit && (
              <button
                type="button"
                className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                onClick={() => setFilter(accountFilter)}
              >
                <ArrowLeft size={12} aria-hidden="true" />
                All conversations
              </button>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="min-w-0">
                <h2 className="truncate font-serif text-base font-bold tracking-[.01em] text-navy" data-testid="text-conversation-patient">
                  {patientNameOf(selected.patientId)}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {viewerAccount?.officeName} · {selected.topic}
                </p>
              </div>
              <span className={CHIP_WARM}>Mock transcript</span>
            </div>
          </div>
          <div className="space-y-4 bg-background/40 px-4 py-5 md:px-6">
            {(HQ_CONVERSATION_MESSAGES[selected.id] ?? []).map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </div>
          <div className="border-t border-border px-5 py-3">
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Read-only transcript imitating the mobile coach thread — cards and one-tap replies render as the patient saw
              them on the phone.
            </p>
          </div>
        </section>
      ) : (
        <div className="rounded-lg border border-card-border bg-card px-5 py-10 text-center shadow-soft">
          <p className="text-xs text-muted-foreground">Select a conversation to read it.</p>
        </div>
      )}
    </div>
  );

  return (
    <AdminPage>
      <PageHeader
        kicker="Coach"
        title="Conversations"
        sub={
          <>
            Coach chatbot transcripts from patients across every provider account. These are mock threads shaped like the
            mobile app&rsquo;s — see the phone for the live experience.{' '}
            <Link href="/admin/accounts" className="font-semibold text-primary hover:underline">
              Browse accounts
            </Link>
          </>
        }
        action={
          <div className="w-full sm:w-64">
            <span className={PANEL_LABEL}>Provider account</span>
            <Select value={accountFilter} onValueChange={setFilter}>
              <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-conversation-account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All accounts ({getConversations().length})</SelectItem>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id} className="text-xs">
                    {account.officeName} ({getConversations(account.id).length})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      <div className="grid gap-5 md:grid-cols-[300px,minmax(0,1fr)]">
        {listPane}
        {viewerPane}
      </div>
    </AdminPage>
  );
}
