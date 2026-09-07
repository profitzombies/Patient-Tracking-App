import { MessageCircleHeart } from 'lucide-react';
import { MICRO_LABEL, SectionCard } from '@/components/patient/heritage';
import type {
  NotificationDeliveryStatus,
  OfficePatientNotifications,
  OutreachRoster,
} from '@/lib/office-roster';

export interface OutreachChipModel {
  label: string;
  className: string;
  title?: string;
}

const ELIGIBLE_CLASS = 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]';
const NEUTRAL_CLASS = 'border-border bg-secondary text-muted-foreground';
const SUCCESS_CLASS = 'border-accent-border bg-accent text-primary';
const MUTED_CLASS = 'border-border bg-paper-alt text-muted-foreground';
const RISK_CLASS = 'border-[#d5a7a7] bg-[#fff0f0] text-[#a04646]';

export function outreachChipModel(outreach: OutreachRoster): OutreachChipModel | null {
  if (outreach.state === 'none') return null;
  if (outreach.state === 'eligible') {
    return { label: 'Outreach due', className: ELIGIBLE_CLASS };
  }
  if (outreach.state === 'engaged') {
    return { label: 'Replied to outreach', className: SUCCESS_CLASS };
  }
  if (outreach.state === 'opted_out' || outreach.delivery === 'opted_out') {
    return { label: 'Nudges paused', className: MUTED_CLASS, title: outreach.deliveryDetail ?? undefined };
  }
  if (outreach.delivery === 'failed') {
    return { label: 'Outreach not delivered', className: RISK_CLASS, title: outreach.deliveryDetail ?? undefined };
  }
  if (outreach.delivery === 'suppressed') {
    return { label: 'Outreach suppressed', className: RISK_CLASS, title: outreach.deliveryDetail ?? undefined };
  }
  if (outreach.delivery === 'expired') {
    return { label: 'Outreach expired', className: MUTED_CLASS, title: outreach.deliveryDetail ?? undefined };
  }
  return { label: 'Outreach sent · awaiting reply', className: NEUTRAL_CLASS };
}

export function OutreachChip({ outreach }: { outreach: OutreachRoster }) {
  const model = outreachChipModel(outreach);
  if (!model) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] ${model.className}`}
      title={model.title}
      data-testid="status-outreach"
    >
      <MessageCircleHeart size={10} aria-hidden="true" />
      {model.label}
    </span>
  );
}

const CATEGORY_LABELS = {
  coach_outreach: 'Coach outreach',
  check_in_reminders: 'Check-in reminder',
  office_reminders: 'Office reminder',
  account: 'Account',
} as const;

function statusClass(status: NotificationDeliveryStatus): string {
  if (status === 'delivered' || status === 'opened') return SUCCESS_CLASS;
  if (status === 'failed' || status === 'suppressed') return RISK_CLASS;
  if (status === 'opted_out' || status === 'expired') return MUTED_CLASS;
  return NEUTRAL_CLASS;
}

function StatusPill({ status }: { status: NotificationDeliveryStatus }) {
  return (
    <span className={`rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] ${statusClass(status)}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function eventLabel(kind: string): string {
  return kind.replaceAll('_', ' ');
}

export function NotificationTimelineContent({
  payload,
  isLoading,
  error,
  formatTimestamp,
}: {
  payload?: OfficePatientNotifications;
  isLoading: boolean;
  error: Error | null;
  formatTimestamp: (date: string) => string;
}) {
  if (isLoading) {
    return <p className="text-xs text-muted-foreground" role="status" data-testid="status-notifications-loading">Loading notification history…</p>;
  }
  if (error) {
    return <p className="text-xs leading-5 text-destructive" role="alert" data-testid="error-notifications">{error.message || 'Notification history could not be loaded.'}</p>;
  }
  if (!payload) {
    return <p className="text-xs leading-5 text-destructive" role="alert" data-testid="error-notifications">Notification history could not be loaded.</p>;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={MICRO_LABEL}>Outreach status</p>
        {payload.outreach.state === 'none'
          ? <span className="text-[10px] text-muted-foreground">No active outreach</span>
          : <OutreachChip outreach={payload.outreach} />}
      </div>
      {payload.notifications.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground" data-testid="empty-notifications">No notifications yet</p>
      ) : (
        <div className="mt-4 space-y-3" data-testid="list-notifications">
          {payload.notifications.map((notification) => (
            <article key={notification.id} className="rounded-md border border-border bg-paper-alt p-3" data-testid={`notification-${notification.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-serif text-sm font-semibold text-navy">{notification.title}</h3>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{CATEGORY_LABELS[notification.category]}</p>
                </div>
                <StatusPill status={notification.status} />
              </div>
              {notification.status === 'queued' && notification.nextAttemptAt && (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Next attempt {formatTimestamp(notification.nextAttemptAt)}
                </p>
              )}
              <ol className="mt-3 space-y-2 border-t border-border pt-3">
                {[...notification.events].sort((a, b) => a.at.localeCompare(b.at)).map((event, index) => (
                  <li key={`${event.at}-${event.kind}-${index}`} className="grid grid-cols-[5rem_1fr] gap-2 text-[10px]">
                    <time dateTime={event.at} className="text-muted-foreground">{formatTimestamp(event.at)}</time>
                    <span>
                      <b className="font-semibold capitalize text-foreground">{eventLabel(event.kind)}</b>
                      {event.detail && <span className="mt-0.5 block leading-4 text-muted-foreground">{event.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function CoachOutreachTimeline({
  payload,
  isLoading,
  error,
  formatTimestamp,
}: {
  payload?: OfficePatientNotifications;
  isLoading: boolean;
  error: Error | null;
  formatTimestamp: (date: string) => string;
}) {
  if (!isLoading && !error && payload?.outreach.state === 'none' && payload.notifications.length === 0) return null;
  return (
    <SectionCard title="Coach outreach" sub="Delivery and patient engagement from the companion app.">
      <div className="p-5" data-testid="card-notification-timeline">
        <NotificationTimelineContent payload={payload} isLoading={isLoading} error={error} formatTimestamp={formatTimestamp} />
      </div>
    </SectionCard>
  );
}