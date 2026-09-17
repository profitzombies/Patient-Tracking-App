/**
 * Office payment activity, with device-local date range and ledger kind
 * filters. Live activity is cursor-paged; the pinned demo filters locally.
 */
import React from 'react';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { ActivityList } from '@/components/payments/ActivityList';
import { Button, ChipRow, ErrorBox, LoadingBox, Panel } from '@/components/payments/primitives';
import { RangePicker, usePaymentsRange } from '@/components/payments/range';
import { useOfficeActivity } from '@/hooks/useOfficeBilling';
import { DEMO_ACTIVITY } from '@/data/office-payments-demo';
import type { HqActivityRow } from '@/lib/office-billing-types';

const OPTIONS = [
  { value: '', label: 'All activity' },
  { value: 'sale', label: 'Payments received' },
  { value: 'refund', label: 'Refunds' },
  { value: 'dispute_opened', label: 'Disputes opened' },
  { value: 'dispute_won', label: 'Disputes won' },
  { value: 'dispute_lost', label: 'Disputes lost' },
  { value: 'payout', label: 'Payouts to your bank' },
] as const;

export default function ActivityScreen() {
  const [kind, setKind] = React.useState('');
  const rows = DEMO_ACTIVITY.filter((row) => !kind || row.kind === kind);

  return (
    <PaymentsScreen
      section="activity"
      title="Payment activity"
      sub="Every payment, refund, dispute and payout for your office."
      demo={<ActivityView kind={kind} setKind={setKind} rows={rows} demo />}
      live={(ctx) => <LiveActivity ctx={ctx} kind={kind} setKind={setKind} />}
    />
  );
}

function LiveActivity({
  ctx,
  kind,
  setKind,
}: {
  ctx: PaymentsLive;
  kind: string;
  setKind: (value: string) => void;
}) {
  const { range } = usePaymentsRange();
  const query = useOfficeActivity(ctx.userId, {
    kind: kind || undefined,
    from: range.from,
    to: range.to,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <RangePicker testIDPrefix="activity-range" />
      {query.isPending ? (
        <LoadingBox label="Loading activity…" testID="activity-loading" />
      ) : query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} testID="activity-error" />
      ) : (
        <ActivityView
          kind={kind}
          setKind={setKind}
          rows={rows}
          more={query.hasNextPage}
          busy={query.isFetchingNextPage}
          onMore={() => void query.fetchNextPage()}
        />
      )}
    </>
  );
}

function ActivityView({
  kind,
  setKind,
  rows,
  demo = false,
  more,
  busy,
  onMore,
}: {
  kind: string;
  setKind: (value: string) => void;
  rows: HqActivityRow[];
  demo?: boolean;
  more?: boolean;
  busy?: boolean;
  onMore?: () => void;
}) {
  return (
    <>
      <ChipRow
        options={OPTIONS}
        value={kind}
        onChange={setKind}
        label="Activity type"
        testIDPrefix="filter-activity"
      />
      <Panel
        title="Activity"
        sub={demo ? `${rows.length} demo entries` : `${rows.length} loaded${more ? ' · more available' : ''}`}
      >
        <ActivityList rows={rows} empty="No activity matches these filters." testID="activity-list" />
        {more && onMore ? (
          <Button
            label={busy ? 'Loading…' : 'Load more'}
            busy={busy}
            onPress={onMore}
            testID="button-activity-more"
          />
        ) : null}
      </Panel>
    </>
  );
}