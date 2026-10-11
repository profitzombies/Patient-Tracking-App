import React, { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { Body, Button, DetailList, InlineNotice, Panel, StatusPill } from '@/components/payments/primitives';
import { useOfficeBillingMutation } from '@/hooks/useOfficeBilling';
import { officeBilling } from '@/lib/office-billing-api';
import { accountStatusLabel, formatDate, formatDateTime, humanizeRequirement } from '@/lib/office-billing-format';
import type { ConnectedAccount } from '@/lib/office-billing-types';

const TITLE = 'Get paid';
const SUB = 'Your office is the merchant of record, pays Stripe’s card processing fees, and has THINNR’s program fee deducted automatically.';

export default function GetPaidScreen() {
  return (
    <PaymentsScreen
      section="get-paid"
      title={TITLE}
      sub={SUB}
      allowNoAccount
      back={{ href: '/payments', label: 'Payments' }}
      live={(ctx) => <GetPaidLive ctx={ctx} />}
    />
  );
}

function mutationMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function SetupCards({ ctx }: { ctx: PaymentsLive }) {
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const oauth = useOfficeBillingMutation(ctx.userId, (_: void, scope) => officeBilling.oauthStart(scope), {
    invalidate: false,
    onSuccess: ({ url }) => {
      setNotice({ tone: 'good', text: 'Stripe connection opened in your browser.' });
      void Linking.openURL(url);
    },
    onError: (error) => setNotice({ tone: 'bad', text: `Stripe connection not started. ${mutationMessage(error, 'Try again.')}` }),
  });
  const oauthAvailable = Boolean(ctx.status.oauth_available);
  return (
    <>
      {notice ? <InlineNotice tone={notice.tone} testID="setup-notice">{notice.text}</InlineNotice> : null}
      <Panel title="Connect an existing Stripe account" sub="Use an account your office already manages.">
        <Body>Authorize THINNR to create charges and deduct the program fee.</Body>
        {oauthAvailable ? (
          <Button label="Connect Stripe" testID="button-oauth-start" busy={oauth.isPending} onPress={() => oauth.mutate()} />
        ) : (
          <Body testID="oauth-unavailable">Existing account connection is not configured yet. You can set up a new account now.</Body>
        )}
      </Panel>
      <Panel title="Set up a new account">
        <Body testID="get-paid-web-handoff">
          New Stripe accounts are created and onboarded from the THINNR web dashboard (Payments → Get paid). Once your office is connected there, this app shows your live payment workspace automatically.
        </Body>
      </Panel>
      <InlineNotice>Stripe’s secure onboarding continues in your browser on mobile.</InlineNotice>
    </>
  );
}

function GetPaidLive({ ctx }: { ctx: PaymentsLive }) {
  const account = ctx.status.account;
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const sync = useOfficeBillingMutation(ctx.userId, (_: void, scope) => officeBilling.sync(scope), {
    onSuccess: () => setNotice({ tone: 'good', text: 'Payment status refreshed' }),
    onError: (error) => setNotice({ tone: 'bad', text: `Status not refreshed. ${mutationMessage(error, 'Try again.')}` }),
  });
  if (!account) return <SetupCards ctx={ctx} />;
  const chip = accountStatusLabel(account);
  const due = [...account.requirements.past_due, ...account.requirements.currently_due];
  const needsOnboarding = !account.details_submitted || account.requirements.currently_due.length > 0;
  return (
    <>
      <View style={styles.actions}>
        <Button label="Refresh status" testID="button-sync-status" busy={sync.isPending} onPress={() => sync.mutate()} />
      </View>
      {notice ? <InlineNotice tone={notice.tone} testID="sync-notice">{notice.text}</InlineNotice> : null}
      <Panel title="Stripe account" action={<StatusPill tone={chip.tone}>{chip.label}</StatusPill>}>
        <View style={styles.flags}>
          <Flag label="Charges" on={account.charges_enabled} />
          <Flag label="Payouts" on={account.payouts_enabled} />
          <Flag label="Details submitted" on={account.details_submitted} />
          <EmailFlag account={account} />
        </View>
        {account.requirements.disabled_reason ? <InlineNotice tone="bad" testID="disabled-reason">{humanizeRequirement(account.requirements.disabled_reason)}</InlineNotice> : null}
      </Panel>
      {due.length ? (
        <Panel title="Information Stripe needs" sub={account.requirements.current_deadline ? `Due ${formatDate(account.requirements.current_deadline)}` : undefined}>
          {due.map((item) => <Body key={item}>• {humanizeRequirement(item)}</Body>)}
        </Panel>
      ) : null}
      {needsOnboarding ? (
        <Panel title="Continue setup" sub="Complete the secure Stripe steps below.">
          <InlineNotice>On mobile, secure Stripe onboarding continues in your browser. Refresh status after you finish.</InlineNotice>
          {ctx.status.oauth_available ? <SetupCards ctx={ctx} /> : null}
        </Panel>
      ) : null}
      <AccountSummary account={account} />
    </>
  );
}

function Flag({ label, on }: { label: string; on: boolean }) {
  return <View style={styles.flag}><Body muted={false}>{label}</Body><StatusPill tone={on ? 'good' : 'warn'}>{on ? 'Enabled' : 'Not ready'}</StatusPill></View>;
}

function EmailFlag({ account }: { account: ConnectedAccount }) {
  const state = account.stripe_customer_emails;
  const label = state === 'off' ? 'Off (THINNR sends them)' : state === 'on' ? 'On in Stripe' : 'Not verified';
  return <View style={styles.flag}><Body muted={false}>Stripe emails</Body><StatusPill testID="stripe-customer-emails" tone={state === 'off' ? 'good' : state === 'on' ? 'bad' : 'warn'}>{label}</StatusPill></View>;
}

function AccountSummary({ account }: { account: ConnectedAccount }) {
  return (
    <Panel title="Connection details">
      <DetailList items={[
        { label: 'Business name', value: account.business_name ?? '—' },
        { label: 'Account', value: account.stripe_account_id },
        { label: 'Currency', value: account.default_currency?.toUpperCase() ?? '—' },
        { label: 'Last synced', value: formatDateTime(account.last_synced_at) },
      ]} />
    </Panel>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  flag: { minWidth: 130, gap: 5 },
});