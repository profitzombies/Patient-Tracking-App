/**
 * HQ Email outbox: every outbound customer email across offices in one paged
 * list, with the vendor's delivery facts (delivered, opened, clicked,
 * bounced) per row, a summary strip counted over the whole filter, and the
 * same preview / resend / send-to-other actions as the order page. Filters
 * live in the query string (single source of truth); the page cursor rides
 * there too, pushed (not replaced) so the browser's Back returns to the
 * previous page. Delivery columns say "Tracking not enabled" while the
 * webhook secret is missing or no event has ever arrived, never zeros.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Eye, Search, Send } from 'lucide-react';
import { AdminPage } from '@/components/admin/primitives';
import { BTN_SECONDARY, INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import { StatusPill } from '@/components/billing/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CUSTOMER_TEMPLATE_OPTIONS, EmailPreviewDialog, SendToDialog, deliveryMarks, emailStatus, plainSendError, templateLabel,
} from '@/components/billing/CustomerEmailsCard';
import { demoEmailDatasetForOrder } from '@/components/billing/customer-emails-demo';
import { RefreshControl } from '@/components/billing/RefreshControl';
import { useCustomerEmailActions, useHqEmailOutbox, useHqProviders } from '@/hooks/use-billing';
import { useToast } from '@/hooks/use-toast';
import { formatDateTime } from '@/lib/billing-format';
import type { CustomerEmail, CustomerEmailList, CustomerEmailSendResult, CustomerEmailSummary } from '@/lib/billing-types';
import { DEMO_ORDERS, DEMO_PROVIDERS } from './demo-data';
import { useBillingSandbox } from './use-billing-sandbox';
import { ErrorBox, Gate, Header, Preview, useUrlFilters } from './shared';

const BASE = '/emails';
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'sent', label: 'Sent' }, { value: 'retrying', label: 'Retrying' }, { value: 'failed', label: 'Failed' }, { value: 'skipped', label: 'Skipped' },
  { value: 'delivered', label: 'Delivered' }, { value: 'opened', label: 'Opened' }, { value: 'clicked', label: 'Clicked' },
  { value: 'delayed', label: 'Delivery delayed' }, { value: 'bounced', label: 'Bounced' }, { value: 'complained', label: 'Marked as spam' },
];
const ICON_BTN = 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const NOT_ENABLED = 'Tracking not enabled';

export function PaymentsEmailOutbox() {
  return <Gate>{(demo, canWrite) => <OutboxBody demo={demo} canAct={canWrite} />}</Gate>;
}

/** Demo rows come from the same per-order builder the transaction detail uses, so both views agree. */
function demoOutbox(filters: Record<string, string>): CustomerEmailList {
  const all = DEMO_ORDERS.flatMap((order) => demoEmailDatasetForOrder(order).emails.map((email) => ({ ...email, office_name: order.office_name, provider_id: order.provider_id })))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const q = (filters.q ?? '').trim().toLowerCase();
  const items = all.filter((email) =>
    (!q || [email.payer_name, email.office_name, email.recipient, email.order_number].some((field) => field?.toLowerCase().includes(q)))
    && (!filters.template || email.template_id === filters.template)
    && (!filters.status || matchesStatus(email, filters.status))
    && (!filters.provider_id || email.provider_id === filters.provider_id)
    && (!filters.from || email.created_at >= `${filters.from}T00:00:00`)
    && (!filters.to || email.created_at <= `${filters.to}T23:59:59.999`));
  return { items, next_cursor: null, payers: [], summary: summarize(items), tracking: { vendor: 'resend', configured: true, last_event_at: items[0]?.created_at ?? null } };
}
function matchesStatus(email: CustomerEmail, status: string): boolean {
  switch (status) {
    case 'delivered': return Boolean(email.delivery.delivered_at);
    case 'opened': return Boolean(email.delivery.opened_at);
    case 'clicked': return Boolean(email.delivery.clicked_at);
    case 'delayed': return Boolean(email.delivery.delayed_at);
    case 'bounced': return Boolean(email.delivery.bounced_at);
    case 'complained': return Boolean(email.delivery.complained_at);
    default: return email.status === status;
  }
}
function summarize(rows: CustomerEmail[]): CustomerEmailSummary {
  return {
    total: rows.length, truncated: false,
    sent: rows.filter((row) => row.status === 'sent').length, failed: rows.filter((row) => row.status === 'failed').length,
    bounced: rows.filter((row) => row.delivery.bounced_at).length, opened: rows.filter((row) => row.delivery.opened_at).length, clicked: rows.filter((row) => row.delivery.clicked_at).length,
  };
}

function OutboxBody({ demo, canAct }: { demo: boolean; canAct: boolean }) {
  const url = useUrlFilters(BASE);
  const [, navigate] = useLocation();
  const filters = Object.fromEntries(url.params.entries());
  const { cursor, ...criteria } = filters;
  const query = useHqEmailOutbox(filters);
  const providers = useHqProviders();
  const sandbox = useBillingSandbox();
  const actions = useCustomerEmailActions('hq');
  const { toast } = useToast();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [sendToId, setSendToId] = useState<string | null>(null);

  const criteriaKey = JSON.stringify(criteria);
  const data = useMemo(() => (demo ? demoOutbox(JSON.parse(criteriaKey) as Record<string, string>) : query.data), [demo, query.data, criteriaKey]);
  const rows = data?.items ?? [];
  const providerRows = demo ? DEMO_PROVIDERS : (providers.data?.items ?? []);
  const tracking = data?.tracking;
  const trackingOn = Boolean(tracking?.configured && tracking?.last_event_at);
  const previewEmail = rows.find((row) => row.id === previewId) ?? null;
  const sendToEmail = rows.find((row) => row.id === sendToId) ?? null;

  const announce = (result: CustomerEmailSendResult, to: string) => {
    if (result.outcome === 'sent') toast({ variant: 'success', title: 'Email sent', description: `Sent again to ${to}.` });
    else if (result.outcome === 'retrying') toast({ title: 'Email queued', description: `Delivery to ${to} will be retried shortly.` });
    else toast({ variant: 'destructive', title: 'Email failed', description: plainSendError(result.email.error) });
  };
  const resend = (email: CustomerEmail, onDone?: () => void) => {
    actions.resend.mutate({ emailId: email.id }, {
      onSuccess: (result) => { announce(result, email.recipient ?? 'the address on record'); onDone?.(); },
      onError: (error) => toast({ variant: 'destructive', title: 'Email failed', description: plainSendError(error.message) }),
    });
  };
  /** Set a criterion and drop the cursor: a new filter always starts at the first page. */
  const setCriterion = (key: string, value: string) => {
    const next = new URLSearchParams(url.params);
    value ? next.set(key, value) : next.delete(key);
    next.delete('cursor');
    navigate(`${BASE}${next.toString() ? `?${next}` : ''}`, { replace: true });
  };
  const goToPage = (nextCursor: string | null) => {
    const next = new URLSearchParams(url.params);
    nextCursor ? next.set('cursor', nextCursor) : next.delete('cursor');
    navigate(`${BASE}${next.toString() ? `?${next}` : ''}`);
  };
  const field = `${INPUT_CLASS} h-9`;

  return (
    <AdminPage>
      <Header
        title="Email outbox"
        sub="Every customer email sent from any office, with delivery, open, and click facts from the email vendor."
        sandbox={sandbox.data?.sandbox}
        action={<RefreshControl subject="Email outbox" demo={demo} sources={[query]} />}
      />
      {demo && <Preview />}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" data-testid="outbox-filters">
        <label className="relative lg:col-span-2">
          <Search className="absolute left-3 top-2.5" size={14} aria-hidden="true" />
          <input
            aria-label="Search emails"
            className={`${field} w-full pl-9`}
            value={filters.q ?? ''}
            onChange={(e) => setCriterion('q', e.target.value)}
            placeholder="Patient, office, phone, email or order number"
            data-testid="input-outbox-search"
          />
        </label>
        <select aria-label="Template" className={field} value={filters.template ?? ''} onChange={(e) => setCriterion('template', e.target.value)} data-testid="select-outbox-template">
          <option value="">All templates</option>
          {CUSTOMER_TEMPLATE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <select aria-label="Status" className={field} value={filters.status ?? ''} onChange={(e) => setCriterion('status', e.target.value)} data-testid="select-outbox-status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="Office" className={field} value={filters.provider_id ?? ''} onChange={(e) => setCriterion('provider_id', e.target.value)} data-testid="select-outbox-office">
          <option value="">All offices</option>
          {providerRows.map((provider) => <option key={provider.provider_id} value={provider.provider_id}>{provider.office_name}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="From date" type="date" className={field} value={filters.from ?? ''} onChange={(e) => setCriterion('from', e.target.value)} data-testid="input-outbox-from" />
          <input aria-label="To date" type="date" className={field} value={filters.to ?? ''} onChange={(e) => setCriterion('to', e.target.value)} data-testid="input-outbox-to" />
        </div>
      </div>

      {data && (
        <SummaryStrip summary={data.summary} trackingOn={trackingOn} />
      )}
      {!demo && data && tracking && !trackingOn && (
        <p role="status" className="mb-4 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground" data-testid="text-outbox-tracking-off">
          {NOT_ENABLED}: {tracking.configured
            ? 'the webhook secret is set but no delivery event has arrived yet. Check the vendor webhook points at /api/email/webhooks/resend and that open and click tracking are switched on for the sending domain.'
            : 'add the RESEND_WEBHOOK_SECRET secret and switch on open and click tracking for the sending domain in the vendor dashboard.'}{' '}
          Details on <Link href="/admin/system-health" className="underline underline-offset-2">System health</Link>.
        </p>
      )}

      {!demo && query.isPending ? (
        <Skeleton className="h-60" data-testid="outbox-loading" />
      ) : !demo && query.isError && !data ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Emails" sub={trackingOn ? 'Opens are pixel-based: many mail apps block or pre-fetch them, so treat them as indicative.' : undefined}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-xs" data-testid="outbox-table">
              <thead>
                <tr className="text-left">
                  <th className="p-3">Time</th>
                  <th>Patient / payer</th>
                  <th>Office</th>
                  <th>Template</th>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Delivered / opened / clicked</th>
                  <th className="text-right pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((email) => {
                  const status = emailStatus(email);
                  const marks = deliveryMarks(email);
                  const label = templateLabel(email.template_id);
                  return (
                    <tr key={email.id} className="border-t align-top" data-testid={`outbox-row-${email.id}`}>
                      <td className="whitespace-nowrap p-3" data-testid="outbox-time">{formatDateTime(email.sent_at ?? email.created_at)}</td>
                      <td className="max-w-[180px] truncate" data-testid="outbox-payer">{email.payer_name ?? '—'}</td>
                      <td className="max-w-[160px] truncate" data-testid="outbox-office">{email.office_name ?? '—'}</td>
                      <td className="whitespace-nowrap" data-testid="outbox-template">
                        {label}
                        {email.kind !== 'automatic' && <span className="ml-1 text-muted-foreground">({email.kind === 'resend' ? 'resent' : 'other address'})</span>}
                        {email.order_number && (
                          email.order_id ? <Link href={`/transactions/${email.order_id}`} className="ml-1 text-primary hover:underline">{email.order_number}</Link> : <span className="ml-1 text-muted-foreground">{email.order_number}</span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate" data-testid="outbox-recipient">{email.recipient ?? '—'}</td>
                      <td><StatusPill tone={status.tone} testId="outbox-status">{status.label}</StatusPill></td>
                      <td data-testid="outbox-delivery">
                        {trackingOn ? (
                          marks.length ? (
                            <div className="flex flex-wrap gap-1">
                              {marks.map((mark) => <StatusPill key={mark.label} tone={mark.tone} testId={`outbox-mark-${mark.label.toLowerCase().replace(/\s+/g, '-')}`}>{mark.label}</StatusPill>)}
                            </div>
                          ) : <span className="text-muted-foreground">{email.status === 'sent' ? 'No events yet' : '—'}</span>
                        ) : (
                          <span className="text-muted-foreground" data-testid="outbox-tracking-off">{NOT_ENABLED}</span>
                        )}
                      </td>
                      <td className="pr-3">
                        <div className="flex items-start justify-end gap-2">
                          <button type="button" className={ICON_BTN} onClick={() => setPreviewId(email.id)} aria-label={`Preview ${label} email`} title="Preview email" data-testid="button-outbox-preview">
                            <Eye size={15} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={`${BTN_SECONDARY} h-8 whitespace-nowrap px-2.5 disabled:cursor-not-allowed disabled:opacity-50`}
                            onClick={() => { actions.sendTo.reset(); setSendToId(email.id); }}
                            disabled={demo || !canAct}
                            title={demo ? 'Sign in to send emails.' : !canAct ? 'Only HQ Admins can send emails.' : undefined}
                            data-testid="button-outbox-send-to"
                          >
                            <Send size={13} aria-hidden="true" /> Send to
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground" data-testid="outbox-empty">No emails match these filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {(cursor || data?.next_cursor) && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground" data-testid="outbox-paging">
              <span>{cursor ? 'Older emails' : 'Most recent emails'}</span>
              <div className="flex gap-2">
                {cursor && <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5`} onClick={() => goToPage(null)} data-testid="button-outbox-first">Newest</button>}
                {data?.next_cursor && <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5`} onClick={() => goToPage(data.next_cursor)} data-testid="button-outbox-next">Older</button>}
              </div>
            </div>
          )}
        </SectionCard>
      )}

      <EmailPreviewDialog
        area="hq"
        email={previewEmail}
        canAct={canAct}
        demo={demo}
        onOpenChange={(open) => { if (!open) { setPreviewId(null); actions.resend.reset(); } }}
        onResend={(email, close) => resend(email, close)}
        resendPending={actions.resend.isPending}
        resendError={actions.resend.error ? plainSendError(actions.resend.error.message) : null}
      />
      <SendToDialog
        email={sendToEmail}
        onOpenChange={(open) => { if (!open) { setSendToId(null); actions.sendTo.reset(); } }}
        pending={actions.sendTo.isPending}
        error={actions.sendTo.error ?? null}
        onSend={(email, to) => actions.sendTo.mutate({ emailId: email.id, to }, { onSuccess: (result) => { announce(result, to); setSendToId(null); } })}
      />
    </AdminPage>
  );
}

/** Counts over the whole active filter, not just the page; delivery counts read "Tracking not enabled" rather than zero until events flow. */
function SummaryStrip({ summary, trackingOn }: { summary: CustomerEmailSummary | undefined; trackingOn: boolean }) {
  if (!summary) return null;
  const tiles: Array<{ label: string; value: string; testId: string }> = [
    { label: 'Sent', value: summary.sent.toLocaleString(), testId: 'summary-sent' },
    { label: 'Failed', value: summary.failed.toLocaleString(), testId: 'summary-failed' },
    { label: 'Bounced', value: trackingOn ? summary.bounced.toLocaleString() : NOT_ENABLED, testId: 'summary-bounced' },
    { label: 'Opened', value: trackingOn ? summary.opened.toLocaleString() : NOT_ENABLED, testId: 'summary-opened' },
    { label: 'Clicked', value: trackingOn ? summary.clicked.toLocaleString() : NOT_ENABLED, testId: 'summary-clicked' },
  ];
  return (
    <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Email counts for the current filter" data-testid="outbox-summary">
      {tiles.map((tile) => (
        <div key={tile.testId} className="rounded-md border border-border bg-card px-3 py-2" data-testid={tile.testId}>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{tile.label}</dt>
          <dd className={`font-semibold text-navy ${tile.value === NOT_ENABLED ? 'text-xs' : 'text-lg'}`}>{tile.value}</dd>
        </div>
      ))}
      {summary.truncated && <p className="col-span-full text-[11px] text-muted-foreground">Counts stop at the first 5,000 matching emails; narrow the filter for exact figures.</p>}
    </dl>
  );
}
