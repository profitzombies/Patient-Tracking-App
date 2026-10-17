import React, { useEffect, useState } from 'react';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { Field, MoneyField, Toggle } from '@/components/payments/dialogs';
import { Body, Button, ChipRow, DetailList, ErrorBox, InlineNotice, LoadingBox, Panel } from '@/components/payments/primitives';
import { useOfficeAppAccessSettings, useOfficeBillingMutation } from '@/hooks/useOfficeBilling';
import { officeBilling, OfficeBillingError } from '@/lib/office-billing-api';
import { centsToDollarsInput, formatCents, formatDateTime, parseDollarsToCents } from '@/lib/office-billing-format';
import type { AppAccessCadence, OfficeAppAccessSettings, OfficeAppAccessSettingsInput } from '@/lib/office-billing-types';

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
      <AppAccessSettingsPanel userId={ctx.userId} />
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

const CADENCES: readonly { value: AppAccessCadence; label: string }[] = [
  { value: '2_weeks', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
];

function AppAccessSettingsPanel({ userId }: { userId: string }) {
  const query = useOfficeAppAccessSettings(userId);
  if (query.isPending) return <LoadingBox label="Loading AI feature pricing…" testID="app-access-loading" />;
  if (query.isError || !query.data) return <ErrorBox error={query.error} retry={() => void query.refetch()} testID="app-access-error" />;
  return <AppAccessSettingsForm settings={query.data} userId={userId} reload={() => query.refetch()} />;
}

/**
 * "Charge patients for AI features" (off by default). Every patient gets the
 * premium AI features free first — the whole 42-day THINNR protocol, or the
 * trial below on any other program; after that, when this is on, the coach,
 * photo reads and barcode lookup lock until the patient subscribes at this
 * price. Food logging, the shop and care-team chat never lock.
 */
function AppAccessSettingsForm({ settings, userId, reload }: { settings: OfficeAppAccessSettings; userId: string; reload: () => Promise<unknown> }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [price, setPrice] = useState(centsToDollarsInput(settings.price_cents));
  const [cadence, setCadence] = useState<AppAccessCadence>(settings.cadence);
  const [trialDays, setTrialDays] = useState(String(settings.trial_days));
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => {
    setEnabled(settings.enabled);
    setPrice(centsToDollarsInput(settings.price_cents));
    setCadence(settings.cadence);
    setTrialDays(String(settings.trial_days));
    setError('');
  }, [settings]);
  const mutation = useOfficeBillingMutation(userId, (body: OfficeAppAccessSettingsInput, scope) => officeBilling.updateAppAccess(body, scope));
  const trial = Number(trialDays);
  const trialValid = trialDays.trim() !== '' && Number.isInteger(trial) && trial >= 0 && trial <= 365;
  const dirty = enabled !== settings.enabled
    || price !== centsToDollarsInput(settings.price_cents)
    || cadence !== settings.cadence
    || trialDays !== String(settings.trial_days);
  const save = () => {
    let cents: number | null = null;
    if (price.trim()) {
      const parsed = parseDollarsToCents(price);
      if (!parsed.ok) { setError(parsed.error); return; }
      if (parsed.cents < 50) { setError('Enter a price of at least $0.50.'); return; }
      cents = parsed.cents;
    }
    if (enabled && cents === null) { setError('Set a price before charging for the app.'); return; }
    if (!trialValid) { setError('The free trial must be a whole number of days between 0 and 365.'); return; }
    setError('');
    setSuccess('');
    mutation.mutate(
      { enabled, price_cents: cents, cadence, trial_days: trial, expected_version: settings.version },
      {
        onSuccess: () => setSuccess(enabled ? 'AI feature pricing saved' : 'AI feature settings saved'),
        onError: async (failure) => {
          if (failure instanceof OfficeBillingError && failure.status === 409) {
            await reload();
            setError('Someone else changed these settings first. Review the latest values and try again.');
            return;
          }
          setError(failure.message || 'Settings could not be saved.');
        },
      },
    );
  };
  const shownTrial = trialValid ? trial : settings.trial_days;
  const parsedPrice = parseDollarsToCents(price);
  const priceLabel = parsedPrice.ok ? formatCents(parsedPrice.cents) : null;
  return (
    <Panel
      title="AI features"
      sub="Optionally charge patients a recurring fee for the app's premium AI features — the coach, photo and menu reads, and barcode lookup. Food logging, the shop and care-team chat always stay free."
      testID="office-app-access-settings"
    >
      <Toggle
        label="Charge patients for AI features"
        value={enabled}
        onChange={(next) => { setEnabled(next); setError(''); setSuccess(''); }}
        testID="toggle-app-access-enabled"
        hint={enabled ? 'After the free window, patients subscribe at your price to keep the AI features.' : 'Every patient keeps the AI features.'}
      />
      <MoneyField
        label="Price"
        value={price}
        onChangeText={(next) => { setPrice(next); setError(''); setSuccess(''); }}
        testID="input-app-access-price"
      />
      <ChipRow options={CADENCES} value={cadence} onChange={(next) => { setCadence(next); setError(''); setSuccess(''); }} label="Billing cadence" testIDPrefix="app-access-cadence" />
      <Field
        label="Free trial for non-THINNR programs (days from activation)"
        value={trialDays}
        onChangeText={(next) => { setTrialDays(next); setError(''); setSuccess(''); }}
        keyboardType="number-pad"
        invalid={!trialValid}
        testID="input-app-access-trial-days"
      />
      <Body testID="text-app-access-summary">
        {`Patients on the THINNR program keep the AI features free through protocol day 42 of their current round; patients on any other program get ${shownTrial} free day${shownTrial === 1 ? '' : 's'}.`}
        {enabled && priceLabel
          ? ` After that they pay ${priceLabel} ${cadence === '2_weeks' ? 'every 2 weeks' : 'a month'} on your connected Stripe account; THINNR keeps ${settings.thinnr_share_percent}% of each charge.`
          : ' Right now nothing locks.'}
      </Body>
      {error ? <InlineNotice tone="bad" testID="text-app-access-error">{error}</InlineNotice> : null}
      {success ? <InlineNotice tone="good" testID="text-app-access-saved">{success}</InlineNotice> : null}
      <Button
        label={mutation.isPending ? 'Saving…' : 'Save AI feature pricing'}
        variant="primary"
        onPress={save}
        disabled={mutation.isPending || !dirty}
        busy={mutation.isPending}
        testID="button-save-app-access"
      />
    </Panel>
  );
}

function ManagedNotice() {
  return <InlineNotice testID="settings-managed-web">These secure settings are managed through Stripe on the office web payments area.</InlineNotice>;
}