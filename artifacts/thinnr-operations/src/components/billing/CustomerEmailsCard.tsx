/**
 * Emails card: every outbound customer email for one order, one payer, or a
 * patient's payers, with preview, resend, send-to-another-address, and the
 * payer's notification contacts. One component serves HQ transaction detail,
 * office order detail, and the patient record; the `area` prop picks the HQ
 * or office ledger routes and the caller decides `canAct` from its own role
 * facts (HQ Admin / office owner or admin). The guided demo renders a fixed
 * dataset through the same views with every write disabled and no requests.
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Eye, Loader2, Mail, MailPlus, RotateCcw, Send, Trash2, Users } from 'lucide-react';
import { EMAIL_TEMPLATE_CATALOG, renderEmailTemplate, type EmailTemplateId } from '@workspace/email-templates';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, INSET, LINK_ACTION, MICRO_LABEL, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { StatusPill } from '@/components/billing/primitives';
import { formatDateTime, type PillTone } from '@/lib/billing-format';
import { useToast } from '@/hooks/use-toast';
import { OfficeApiError } from '@/lib/office-api';
import {
  useCustomerEmailActions, useCustomerEmailPreview, useCustomerEmails, useNotificationContacts,
  type EmailLedgerArea, type EmailLedgerFilter,
} from '@/hooks/use-billing';
import type { CustomerEmail, CustomerEmailPreview, CustomerEmailSendResult, NotificationContact } from '@/lib/billing-types';
import type { DemoEmailDataset } from '@/components/billing/customer-emails-demo';

// ---------------------------------------------------------------- vocabulary

/** Plain-language names; anything not listed falls back to the template catalog name. */
const TEMPLATE_LABEL: Record<string, string> = {
  'order-confirmation': 'Order confirmation',
  'order-receipt': 'Receipt',
  'order-shipped': 'Shipped',
  'order-delivered': 'Delivered',
  'subscription-renewal-reminder': 'Renewal reminder',
  'subscription-payment-failed': 'Payment failed',
  'subscription-cancelled': 'Subscription cancelled',
  'subscription-started': 'Subscription started',
  'subscription-shipment-moved': 'Shipment date moved',
  'subscription-shipment-skipped': 'Shipment skipped',
  'subscription-paused': 'Subscription paused',
  'subscription-resumed': 'Subscription resumed',
  'subscription-plan-changed': 'Plan changed',
  'subscription-address-changed': 'Address changed',
  'subscription-card-updated': 'Card updated',
};
export function templateLabel(templateId: string): string {
  return TEMPLATE_LABEL[templateId]
    ?? EMAIL_TEMPLATE_CATALOG.find((template) => template.id === templateId)?.name
    ?? templateId.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const KIND_LABEL: Record<CustomerEmail['kind'], string | null> = { automatic: null, resend: 'Resent', send_to_other: 'Sent to another address' };

export function emailStatus(email: CustomerEmail): { label: string; tone: PillTone } {
  switch (email.status) {
    case 'sent': return { label: 'Sent', tone: 'good' };
    case 'retrying': return { label: `Retrying, attempt ${email.attempts} of ${email.max_attempts}`, tone: 'warn' };
    case 'claimed': return { label: 'Sending', tone: 'info' };
    case 'failed': return { label: 'Failed', tone: 'bad' };
    case 'skipped': return { label: 'Skipped', tone: 'neutral' };
    default: return { label: email.status, tone: 'neutral' };
  }
}

const MARKS: Array<{ type: string; label: string; tone: PillTone }> = [
  { type: 'delivered', label: 'Delivered', tone: 'good' },
  { type: 'opened', label: 'Opened', tone: 'info' },
  { type: 'clicked', label: 'Clicked', tone: 'info' },
  { type: 'delivery_delayed', label: 'Delayed', tone: 'warn' },
  { type: 'bounced', label: 'Bounced', tone: 'bad' },
  { type: 'complained', label: 'Marked as spam', tone: 'bad' },
];
export function deliveryMarks(email: CustomerEmail): Array<{ label: string; tone: PillTone; at: string }> {
  return MARKS.flatMap((mark) => {
    const hit = email.events.find((row) => row.event_type === mark.type);
    return hit ? [{ label: mark.label, tone: mark.tone, at: hit.occurred_at }] : [];
  });
}

/** Vendor and transport errors, said plainly. Unknown messages pass through untouched. */
export function plainSendError(raw: string | null | undefined): string {
  if (!raw) return 'The email could not be sent.';
  const text = raw.trim();
  if (/ETIMEDOUT|timed? ?out/i.test(text)) return 'The email service did not respond in time.';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(text)) return 'The email service could not be reached.';
  if (/\b(550|551|553)\b|mailbox|no such user|does not exist/i.test(text)) return 'The address rejected the message (mailbox not found).';
  if (/\b(421|450|451|452)\b|rate ?limit|too many/i.test(text)) return 'The email service asked us to slow down; it will be retried.';
  if (/\b(401|403)\b|unauthori[sz]ed|api key/i.test(text)) return 'The email service rejected our credentials.';
  return text.endsWith('.') ? text : `${text}.`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (value: string) => EMAIL_PATTERN.test(value.trim());

const ICON_BTN = 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const DEMO_HINT = 'Sign in to send emails from a live office.';

// ---------------------------------------------------------------- card

export interface CustomerEmailsCardProps {
  area: EmailLedgerArea;
  filter: EmailLedgerFilter;
  /** Payer whose notification contacts the card manages; omitted on patient pages, where the list response names the payer(s). */
  payer?: { id: string; name: string; email: string | null } | null;
  /** Whether this viewer may resend, send to other addresses, and edit contacts. */
  canAct: boolean;
  /** Guided demo: a fixed dataset rendered with every action disabled and no requests. */
  demo?: DemoEmailDataset | null;
  title?: string;
  sub?: string;
  className?: string;
  /** Copy for a 403 from the ledger routes. */
  forbiddenMessage?: string;
}

export function CustomerEmailsCard(props: CustomerEmailsCardProps) {
  return props.demo ? <DemoCustomerEmailsCard {...props} demo={props.demo} /> : <LiveCustomerEmailsCard {...props} />;
}

function LiveCustomerEmailsCard({ area, filter, payer, canAct, title, sub, className, forbiddenMessage }: CustomerEmailsCardProps) {
  const query = useCustomerEmails(area, filter, {
    // A 403 is a fact about the caller's role, not a transient failure.
    retry: (count, error) => (error instanceof OfficeApiError && error.isForbidden ? false : count < 1),
  });
  const actions = useCustomerEmailActions(area);
  const { toast } = useToast();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [sendToId, setSendToId] = useState<string | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);

  const emails = query.data?.items ?? [];
  const payers = useMemo(() => {
    if (payer) return [payer];
    const listed = query.data?.payers ?? [];
    if (listed.length) return listed;
    // Order rows always carry their payer; fall back to it when the list is unscoped.
    const seen = new Map<string, { id: string; name: string; email: string | null }>();
    for (const email of emails) if (email.payer_id && !seen.has(email.payer_id)) seen.set(email.payer_id, { id: email.payer_id, name: email.payer_name ?? 'Payer', email: null });
    return [...seen.values()];
  }, [payer, query.data, emails]);
  const previewEmail = emails.find((row) => row.id === previewId) ?? null;
  const sendToEmail = emails.find((row) => row.id === sendToId) ?? null;

  const announceOutcome = (result: CustomerEmailSendResult, to: string) => {
    if (result.outcome === 'sent') toast({ variant: 'success', title: 'Email sent', description: `Sent again to ${to}.` });
    else if (result.outcome === 'retrying') toast({ title: 'Email queued', description: `Delivery to ${to} will be retried shortly.` });
    else toast({ variant: 'destructive', title: 'Email failed', description: plainSendError(result.email.error) });
  };
  const resend = (email: CustomerEmail, onDone?: () => void) => {
    actions.resend.mutate({ emailId: email.id }, {
      onSuccess: (result) => { announceOutcome(result, email.recipient ?? 'the address on record'); onDone?.(); },
      onError: (error) => toast({ variant: 'destructive', title: 'Email failed', description: plainSendError(error.message) }),
    });
  };

  const body: ReactNode = query.isPending ? (
    <div className="flex items-center gap-2 p-5 text-xs text-muted-foreground" role="status" data-testid="emails-loading">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading emails…
    </div>
  ) : query.isError ? (
    <EmailsProblem error={query.error} retry={() => void query.refetch()} forbiddenMessage={forbiddenMessage} />
  ) : (
    <EmailRows
      emails={emails}
      canAct={canAct}
      onPreview={(email) => setPreviewId(email.id)}
      onSendTo={(email) => { actions.sendTo.reset(); setSendToId(email.id); }}
      onRetry={(email) => resend(email)}
      retryingId={actions.resend.isPending ? actions.resend.variables?.emailId ?? null : null}
      footer={query.data?.next_cursor ? <p className="px-5 pb-4 text-[11px] text-muted-foreground" data-testid="emails-more">Showing the 50 most recent emails.</p> : null}
    />
  );

  return (
    <SectionCard
      title={title ?? 'Emails'}
      sub={sub ?? 'Every email sent to the payer for this record.'}
      className={className}
      action={payers.length > 0 && !query.isError ? (
        <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5`} onClick={() => setContactsOpen(true)} data-testid="button-notification-emails">
          <Users size={13} aria-hidden="true" /> Notification emails
        </button>
      ) : undefined}
    >
      {body}
      <EmailPreviewDialog
        area={area}
        email={previewEmail}
        canAct={canAct}
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
        onSend={(email, to) => actions.sendTo.mutate({ emailId: email.id, to }, {
          onSuccess: (result) => { announceOutcome(result, to); setSendToId(null); },
        })}
      />
      {payers.length > 0 && (
        <NotificationContactsDialog
          area={area}
          payers={payers}
          open={contactsOpen}
          onOpenChange={setContactsOpen}
          canAct={canAct}
        />
      )}
    </SectionCard>
  );
}

function DemoCustomerEmailsCard({ demo, canAct, title, sub, className }: CustomerEmailsCardProps & { demo: DemoEmailDataset }) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const previewEmail = demo.emails.find((row) => row.id === previewId) ?? null;
  return (
    <SectionCard
      title={title ?? 'Emails'}
      sub={sub ?? 'Every email sent to the payer for this record.'}
      className={className}
      action={(
        <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5`} onClick={() => setContactsOpen(true)} data-testid="button-notification-emails">
          <Users size={13} aria-hidden="true" /> Notification emails
        </button>
      )}
    >
      <EmailRows emails={demo.emails} canAct={canAct} demo onPreview={(email) => setPreviewId(email.id)} onSendTo={() => {}} onRetry={() => {}} retryingId={null} />
      <EmailPreviewDialog email={previewEmail} canAct={canAct} demo onOpenChange={(open) => { if (!open) setPreviewId(null); }} onResend={() => {}} resendPending={false} resendError={null} />
      <NotificationContactsDialog payers={[demo.payer]} demoContacts={demo.contacts} open={contactsOpen} onOpenChange={setContactsOpen} canAct={canAct} />
    </SectionCard>
  );
}

function EmailsProblem({ error, retry, forbiddenMessage }: { error: unknown; retry: () => void; forbiddenMessage?: string }) {
  const forbidden = error instanceof OfficeApiError && error.isForbidden;
  return (
    <div className="p-5" data-testid={forbidden ? 'emails-forbidden' : 'emails-error'}>
      <div className="flex items-start gap-2 text-xs text-muted-foreground" role={forbidden ? undefined : 'alert'}>
        <Mail size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold text-navy">
            {forbidden ? forbiddenMessage ?? 'Emails are visible to office owners and admins.' : 'Emails could not be loaded.'}
          </p>
          {!forbidden && (
            <p className="mt-1">
              {error instanceof Error ? error.message : 'Try again in a moment.'}{' '}
              <button type="button" onClick={retry} className={`${LINK_ACTION} text-xs`} data-testid="button-emails-retry">Retry</button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rows

function EmailRows({ emails, canAct, demo = false, onPreview, onSendTo, onRetry, retryingId, footer }: {
  emails: CustomerEmail[];
  canAct: boolean;
  demo?: boolean;
  onPreview: (email: CustomerEmail) => void;
  onSendTo: (email: CustomerEmail) => void;
  onRetry: (email: CustomerEmail) => void;
  retryingId: string | null;
  footer?: ReactNode;
}) {
  if (!emails.length) {
    return <p className="p-5 text-xs text-muted-foreground" data-testid="emails-empty">No emails have been sent for this record yet.</p>;
  }
  const actDisabled = demo || !canAct;
  const actTitle = demo ? DEMO_HINT : !canAct ? 'Only office owners and admins can send emails.' : undefined;
  return (
    <>
      <ul className="divide-y divide-border" data-testid="emails-list">
        {emails.map((email) => {
          const status = emailStatus(email);
          const marks = deliveryMarks(email);
          const kind = KIND_LABEL[email.kind];
          const label = templateLabel(email.template_id);
          const retrying = retryingId === email.id;
          return (
            <li key={email.id} className="grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto]" data-testid={`email-row-${email.id}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-navy" data-testid="email-template">{label}</span>
                  {kind && <StatusPill tone="neutral" testId="email-kind">{kind}</StatusPill>}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="email-recipient">
                  To <span className="text-foreground">{email.recipient ?? 'no address on record'}</span>
                  {email.order_number && <> · Order {email.order_number}</>}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <StatusPill tone={status.tone} testId="email-status">{status.label}</StatusPill>
                  <span data-testid="email-time">{email.sent_at ? formatDateTime(email.sent_at) : email.status === 'retrying' && email.next_attempt_at ? `Next try ${formatDateTime(email.next_attempt_at)}` : formatDateTime(email.created_at)}</span>
                  {marks.map((mark) => (
                    <StatusPill key={mark.label} tone={mark.tone} testId={`email-mark-${mark.label.toLowerCase().replace(/\s+/g, '-')}`}>{mark.label}</StatusPill>
                  ))}
                </div>
                {email.status === 'failed' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive" data-testid="email-failure">
                    <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
                    <span>{plainSendError(email.error)}</span>
                    <button
                      type="button"
                      className={`${LINK_ACTION} text-xs disabled:cursor-not-allowed disabled:opacity-50`}
                      onClick={() => onRetry(email)}
                      disabled={actDisabled || retrying}
                      title={actTitle}
                      data-testid="button-retry-now"
                    >
                      {retrying ? 'Retrying…' : 'Retry now'}
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-start gap-2 sm:justify-end">
                <button type="button" className={ICON_BTN} onClick={() => onPreview(email)} aria-label={`Preview ${label} email`} title="Preview email" data-testid="button-preview-email">
                  <Eye size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`${BTN_SECONDARY} h-8 whitespace-nowrap px-2.5 disabled:cursor-not-allowed disabled:opacity-50`}
                  onClick={() => onSendTo(email)}
                  disabled={actDisabled}
                  title={actTitle}
                  data-testid="button-send-to-other"
                >
                  <Send size={13} aria-hidden="true" /> Send to a different email
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {footer}
    </>
  );
}

// ---------------------------------------------------------------- preview dialog

function EmailPreviewDialog({ area, email, canAct, demo = false, onOpenChange, onResend, resendPending, resendError }: {
  area?: EmailLedgerArea;
  email: CustomerEmail | null;
  canAct: boolean;
  demo?: boolean;
  onOpenChange: (open: boolean) => void;
  onResend: (email: CustomerEmail, close: () => void) => void;
  resendPending: boolean;
  resendError: string | null;
}) {
  return (
    <Dialog open={Boolean(email)} onOpenChange={onOpenChange}>
      {email && (
        <PreviewBody area={area} email={email} canAct={canAct} demo={demo} close={() => onOpenChange(false)} onResend={onResend} resendPending={resendPending} resendError={resendError} />
      )}
    </Dialog>
  );
}

function PreviewBody({ area, email, canAct, demo, close, onResend, resendPending, resendError }: {
  area?: EmailLedgerArea;
  email: CustomerEmail;
  canAct: boolean;
  demo: boolean;
  close: () => void;
  onResend: (email: CustomerEmail, close: () => void) => void;
  resendPending: boolean;
  resendError: string | null;
}) {
  const [format, setFormat] = useState<'html' | 'text'>('html');
  const [confirming, setConfirming] = useState(false);
  const live = useCustomerEmailPreview(demo ? 'office' : area ?? 'office', demo ? null : email.id);
  const demoPreview = useMemo<CustomerEmailPreview | null>(() => {
    if (!demo) return null;
    const definition = EMAIL_TEMPLATE_CATALOG.find((template) => template.id === email.template_id);
    if (!definition) return null;
    const rendered = renderEmailTemplate(definition.id as EmailTemplateId, definition.sampleVariables);
    return { subject: email.subject ?? rendered.subject, html: rendered.html, text: rendered.text };
  }, [demo, email]);
  const preview = demo ? demoPreview : live.data ?? null;
  const label = templateLabel(email.template_id);
  const status = emailStatus(email);
  const titleId = useId();
  const resendDisabled = demo || !canAct || resendPending;
  const resendTitle = demo ? DEMO_HINT : !canAct ? 'Only office owners and admins can resend emails.' : undefined;

  return (
    <DialogContent className="max-w-3xl" aria-labelledby={titleId} data-testid="dialog-email-preview">
      {/* Resend sits at the top right, immediately left of the built-in Close (right-4 top-4). */}
      <button
        type="button"
        className={`${BTN_PRIMARY} absolute right-12 top-3 h-8 px-3 disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => setConfirming(true)}
        disabled={resendDisabled || confirming}
        title={resendTitle}
        aria-disabled={resendDisabled || confirming}
        data-testid="button-preview-resend"
      >
        <RotateCcw size={13} aria-hidden="true" /> Resend
      </button>
      <DialogHeader className="pr-36">
        <DialogTitle id={titleId}>{label}</DialogTitle>
        <DialogDescription>
          {preview?.subject ?? email.subject ?? 'Email preview'} · To {email.recipient ?? 'no address on record'} · {status.label}
          {email.sent_at ? ` ${formatDateTime(email.sent_at)}` : ''}
        </DialogDescription>
      </DialogHeader>

      {confirming && (
        <div className={`${INSET} flex flex-wrap items-center justify-between gap-2 px-3 py-2`} role="group" aria-label="Confirm resend" data-testid="resend-confirm">
          <p className="text-xs text-foreground">Send this email again to <strong>{email.recipient ?? 'the address on record'}</strong>?</p>
          <div className="flex gap-2">
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => setConfirming(false)} disabled={resendPending} data-testid="button-cancel-resend">Cancel</button>
            <button type="button" className={`${BTN_PRIMARY} h-8 px-3`} onClick={() => onResend(email, close)} disabled={resendPending} data-testid="button-confirm-resend">
              {resendPending ? <><Loader2 size={13} className="animate-spin" aria-hidden="true" /> Sending…</> : 'Send again'}
            </button>
          </div>
        </div>
      )}
      {resendError && <p className="text-xs font-semibold text-destructive" role="alert" data-testid="resend-error">{resendError}</p>}

      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Preview format">
          {(['html', 'text'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`rounded-sm px-2.5 py-1 text-xs font-semibold transition ${format === option ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              aria-pressed={format === option}
              onClick={() => setFormat(option)}
              data-testid={`button-preview-${option}`}
            >
              {option === 'html' ? 'Rendered' : 'Plain text'}
            </button>
          ))}
        </div>
        {email.kind !== 'automatic' && <span className={MICRO_LABEL}>{KIND_LABEL[email.kind]}</span>}
      </div>

      {!demo && live.isPending ? (
        <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground" role="status" data-testid="preview-loading">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Rendering email…
        </div>
      ) : !preview ? (
        <p className="rounded-md border border-border bg-secondary px-3 py-4 text-xs text-muted-foreground" role="alert" data-testid="preview-unavailable">
          {live.error instanceof Error ? live.error.message : 'This email cannot be previewed.'}
        </p>
      ) : format === 'html' ? (
        <iframe
          title={`${label} email preview`}
          sandbox=""
          srcDoc={preview.html}
          className="h-[480px] w-full rounded-md border border-border bg-white"
          data-testid="preview-frame"
        />
      ) : (
        <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-secondary p-3 font-mono text-xs text-foreground" data-testid="preview-text">{preview.text}</pre>
      )}
    </DialogContent>
  );
}

// ---------------------------------------------------------------- send to a different email

function SendToDialog({ email, onOpenChange, onSend, pending, error }: {
  email: CustomerEmail | null;
  onOpenChange: (open: boolean) => void;
  onSend: (email: CustomerEmail, to: string) => void;
  pending: boolean;
  error: Error | null;
}) {
  const [to, setTo] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => { setTo(''); setLocalError(null); }, [email?.id]);
  const serverFieldError = error instanceof OfficeApiError && error.field === 'email' ? error.message : null;
  const fieldError = localError ?? serverFieldError;
  const generalError = error && !serverFieldError ? plainSendError(error.message) : null;
  const inputId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!email) return;
    if (!isValidEmail(to)) { setLocalError('Enter a valid email address.'); return; }
    setLocalError(null);
    onSend(email, to.trim());
  };
  return (
    <Dialog open={Boolean(email)} onOpenChange={onOpenChange}>
      {email && (
        <DialogContent className="max-w-md" data-testid="dialog-send-to">
          <form onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>Send to a different email</DialogTitle>
              <DialogDescription>
                Sends the {templateLabel(email.template_id).toLowerCase()} email{email.order_number ? ` for order ${email.order_number}` : ''} to one other address. The address on record is not changed.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-1.5">
              <label htmlFor={inputId} className={PANEL_LABEL}>Email address</label>
              <input
                id={inputId}
                type="email"
                inputMode="email"
                autoComplete="off"
                className={`${INPUT_CLASS} h-9 w-full`}
                value={to}
                onChange={(event) => { setTo(event.target.value); setLocalError(null); }}
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? `${inputId}-error` : undefined}
                placeholder="name@example.com"
                data-testid="input-send-to-email"
              />
              {fieldError && <p id={`${inputId}-error`} className="text-xs font-semibold text-destructive" role="alert" data-testid="send-to-error">{fieldError}</p>}
              {generalError && <p className="text-xs font-semibold text-destructive" role="alert" data-testid="send-to-error">{generalError}</p>}
            </div>
            <DialogFooter className="mt-5">
              <button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => onOpenChange(false)} disabled={pending}>Cancel</button>
              <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} disabled={pending} data-testid="button-send-to-submit">
                {pending ? <><Loader2 size={13} className="animate-spin" aria-hidden="true" /> Sending…</> : <><Send size={13} aria-hidden="true" /> Send email</>}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- notification contacts

function NotificationContactsDialog({ area, payers, demoContacts, open, onOpenChange, canAct }: {
  area?: EmailLedgerArea;
  payers: Array<{ id: string; name: string; email: string | null }>;
  demoContacts?: NotificationContact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canAct: boolean;
}) {
  const [payerId, setPayerId] = useState(payers[0]?.id ?? '');
  useEffect(() => { if (!payers.some((row) => row.id === payerId)) setPayerId(payers[0]?.id ?? ''); }, [payers, payerId]);
  const payer = payers.find((row) => row.id === payerId) ?? payers[0] ?? null;
  const selectId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && payer && (
        <DialogContent className="max-w-lg" data-testid="dialog-notification-contacts">
          <DialogHeader>
            <DialogTitle>Notification emails</DialogTitle>
            <DialogDescription>
              Extra addresses that automatically receive future order and shipment emails for {payer.name}
              {payer.email ? <> (payer email: <span className="text-foreground">{payer.email}</span>)</> : null}.
            </DialogDescription>
          </DialogHeader>
          {payers.length > 1 && (
            <div className="space-y-1.5">
              <label htmlFor={selectId} className={PANEL_LABEL}>Payer</label>
              <select id={selectId} className={`${INPUT_CLASS} h-9 w-full`} value={payer.id} onChange={(event) => setPayerId(event.target.value)} data-testid="select-contacts-payer">
                {payers.map((row) => <option key={row.id} value={row.id}>{row.name}{row.email ? ` · ${row.email}` : ''}</option>)}
              </select>
            </div>
          )}
          {demoContacts
            ? <ContactsList contacts={demoContacts} canAct={false} demo onRemove={() => {}} removingId={null} />
            : <LiveContacts area={area ?? 'office'} payer={payer} canAct={canAct} />}
        </DialogContent>
      )}
    </Dialog>
  );
}

function LiveContacts({ area, payer, canAct }: { area: EmailLedgerArea; payer: { id: string; name: string; email: string | null }; canAct: boolean }) {
  const query = useNotificationContacts(area, payer.id);
  const { addContact, removeContact } = useCustomerEmailActions(area);
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const emailId = useId();
  const labelId = useId();
  const serverError = addContact.error instanceof OfficeApiError ? addContact.error : null;
  const fieldError = localError ?? (serverError?.field === 'email' ? serverError.message : null);
  const generalError = addContact.error && !(serverError?.field === 'email') ? addContact.error.message : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!isValidEmail(email)) { setLocalError('Enter a valid email address.'); return; }
    setLocalError(null);
    addContact.mutate({ payerId: payer.id, email: email.trim(), label: label.trim() || null }, {
      onSuccess: (result) => {
        setEmail(''); setLabel('');
        toast({ variant: 'success', title: 'Notification email added', description: `${result.contact.email} will receive future order and shipment emails.` });
      },
    });
  };
  const remove = (contact: NotificationContact) => {
    removeContact.mutate({ payerId: payer.id, contactId: contact.id }, {
      onSuccess: () => toast({ title: 'Notification email removed', description: `${contact.email} will no longer receive order emails.` }),
      onError: (error) => toast({ variant: 'destructive', title: 'Could not remove address', description: error.message }),
    });
  };

  return (
    <>
      {query.isPending ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground" role="status" data-testid="contacts-loading">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading addresses…
        </div>
      ) : query.isError ? (
        <p className="text-xs font-semibold text-destructive" role="alert" data-testid="contacts-error">
          {query.error.message}{' '}
          <button type="button" className={`${LINK_ACTION} text-xs`} onClick={() => void query.refetch()}>Retry</button>
        </p>
      ) : (
        <ContactsList
          contacts={query.data.contacts}
          canAct={canAct}
          onRemove={remove}
          removingId={removeContact.isPending ? removeContact.variables?.contactId ?? null : null}
        />
      )}
      {canAct && !query.isError && (
        <form onSubmit={submit} noValidate className={`${INSET} space-y-3 p-3`} data-testid="form-add-contact">
          <p className={PANEL_LABEL}>Add an address</p>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,140px)]">
            <div className="space-y-1.5">
              <label htmlFor={emailId} className={MICRO_LABEL}>Email address</label>
              <input
                id={emailId}
                type="email"
                inputMode="email"
                autoComplete="off"
                className={`${INPUT_CLASS} h-9 w-full`}
                value={email}
                onChange={(event) => { setEmail(event.target.value); setLocalError(null); addContact.reset(); }}
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? `${emailId}-error` : undefined}
                placeholder="name@example.com"
                data-testid="input-contact-email"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={labelId} className={MICRO_LABEL}>Label <span className="font-normal normal-case tracking-normal">(optional)</span></label>
              <input id={labelId} type="text" className={`${INPUT_CLASS} h-9 w-full`} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} placeholder="Spouse" data-testid="input-contact-label" />
            </div>
          </div>
          {fieldError && <p id={`${emailId}-error`} className="text-xs font-semibold text-destructive" role="alert" data-testid="contact-error">{fieldError}</p>}
          {generalError && <p className="text-xs font-semibold text-destructive" role="alert" data-testid="contact-error">{generalError}</p>}
          <div className="flex justify-end">
            <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} disabled={addContact.isPending} data-testid="button-add-contact">
              {addContact.isPending ? <><Loader2 size={13} className="animate-spin" aria-hidden="true" /> Adding…</> : <><MailPlus size={13} aria-hidden="true" /> Add address</>}
            </button>
          </div>
        </form>
      )}
      {!canAct && <p className="text-[11px] text-muted-foreground" data-testid="contacts-readonly">Only office owners and admins can change notification emails.</p>}
    </>
  );
}

function ContactsList({ contacts, canAct, demo = false, onRemove, removingId }: {
  contacts: NotificationContact[];
  canAct: boolean;
  demo?: boolean;
  onRemove: (contact: NotificationContact) => void;
  removingId: string | null;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!contacts.length) return <p className="text-xs text-muted-foreground" data-testid="contacts-empty">No extra addresses yet. Only the payer receives order emails.</p>;
  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-testid="contacts-list">
      {contacts.map((contact) => {
        const removing = removingId === contact.id;
        const confirming = confirmId === contact.id;
        return (
          <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid={`contact-row-${contact.id}`}>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-navy">{contact.email}{contact.label ? <span className="ml-2 text-xs font-normal text-muted-foreground">{contact.label}</span> : null}</p>
              <p className="text-[11px] text-muted-foreground" data-testid="contact-added">
                Added {formatDateTime(contact.created_at)}{contact.added_by_name ? ` by ${contact.added_by_name}` : ''}
              </p>
            </div>
            {confirming ? (
              <div className="flex items-center gap-2" role="group" aria-label={`Confirm removing ${contact.email}`}>
                <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5`} onClick={() => setConfirmId(null)} disabled={removing}>Keep</button>
                <button type="button" className={`${BTN_PRIMARY} h-8 bg-destructive px-2.5 hover:bg-destructive/90`} onClick={() => { onRemove(contact); setConfirmId(null); }} disabled={removing} data-testid="button-confirm-remove-contact">
                  Remove
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${ICON_BTN} hover:text-destructive`}
                onClick={() => setConfirmId(contact.id)}
                disabled={demo || !canAct || removing}
                title={demo ? DEMO_HINT : !canAct ? 'Only office owners and admins can remove addresses.' : 'Remove address'}
                aria-label={`Remove ${contact.email}`}
                data-testid="button-remove-contact"
              >
                {removing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
