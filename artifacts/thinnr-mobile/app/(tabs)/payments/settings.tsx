import React, { useState } from 'react';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { ChipRow, DetailList, InlineNotice, Panel } from '@/components/payments/primitives';
import { formatDateTime } from '@/lib/office-billing-format';

const TABS = [
  { value: 'bank', label: 'Bank and payouts' },
  { value: 'identity', label: 'Identity and business' },
  { value: 'tax', label: 'Sales tax' },
  { value: 'documents', label: 'Documents' },
] as const;
type Tab = (typeof TABS)[number]['value'];

export default function PaymentSettingsScreen() {
  return (
    <PaymentsScreen
      section="settings"
      title="Payment settings"
      sub="Manage sensitive payment details securely through Stripe."
      live={(ctx) => <SettingsView ctx={ctx} />}
    />
  );
}

function SettingsView({ ctx }: { ctx: PaymentsLive }) {
  const [tab, setTab] = useState<Tab>('bank');
  const account = ctx.status.account!;
  const title = TABS.find((item) => item.value === tab)!.label;
  return (
    <>
      <ChipRow options={TABS} value={tab} onChange={setTab} label="Payment settings sections" testIDPrefix="settings-tab" />
      <Panel title={title}>
        {tab === 'bank' ? (
          <>
            <DetailList testID="settings-bank-summary" items={[
              { label: 'Payouts', value: account.payouts_enabled ? 'Enabled' : 'Not ready' },
              { label: 'Currency', value: account.default_currency?.toUpperCase() ?? '—' },
              { label: 'Stripe account', value: account.stripe_account_id },
              { label: 'Last synced', value: formatDateTime(account.last_synced_at) },
            ]} />
            <ManagedNotice />
          </>
        ) : tab === 'identity' ? (
          <>
            <DetailList testID="settings-identity-summary" items={[
              { label: 'Business name', value: account.business_name ?? ctx.status.office.office_name },
              { label: 'Email', value: account.email ?? '—' },
              { label: 'Business details', value: account.details_submitted ? 'Submitted' : 'Incomplete' },
              { label: 'Account type', value: account.origin === 'oauth' ? 'Connected Stripe account' : 'THINNR-created Stripe account' },
            ]} />
            <ManagedNotice />
          </>
        ) : tab === 'tax' ? (
          <>
            <InlineNotice>Sales tax is your office’s responsibility. Stripe Tax pricing applies directly to your connected account.</InlineNotice>
            <DetailList items={[{ label: 'Stripe Tax', value: account.tax_enabled ? 'Enabled' : 'Not enabled' }]} />
            <ManagedNotice />
          </>
        ) : (
          <>
            <DetailList items={[{ label: 'Verification documents', value: account.details_submitted ? 'Submitted' : 'Information may be required' }]} />
            <ManagedNotice />
          </>
        )}
      </Panel>
      {account.stripe_customer_emails !== 'off' ? (
        <InlineNotice tone={account.stripe_customer_emails === 'on' ? 'bad' : 'warn'} testID="settings-email-notice">
          {account.stripe_customer_emails_note ?? 'THINNR sends every receipt and subscription email; Stripe’s own customer emails should stay off in the Stripe Dashboard.'}
        </InlineNotice>
      ) : null}
    </>
  );
}

function ManagedNotice() {
  return <InlineNotice testID="settings-managed-web">These secure settings are managed through Stripe on the office web payments area.</InlineNotice>;
}