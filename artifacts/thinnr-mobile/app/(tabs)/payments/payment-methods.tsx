import React, { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { PaymentsScreen } from '@/components/payments/PaymentsScreen';
import { Body, Button, DetailList, InlineNotice, LoadingBox, Panel, StatusPill } from '@/components/payments/primitives';
import OfficeAccessCardForm from '@/components/payments/OfficeAccessCardForm';
import { useOfficeAccess, useOfficeBillingMutation } from '@/hooks/useOfficeBilling';
import { officeBilling, OfficeBillingError } from '@/lib/office-billing-api';
import { formatCents } from '@/lib/office-billing-format';
import type { OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/office-access-types';

const SLOT_LABEL: Record<OfficeAccessSlot, string> = {
  bank: 'Bank account',
  card_primary: 'Primary card',
  card_backup: 'Backup card',
};

export default function PaymentMethodsScreen() {
  return (
    <PaymentsScreen
      section="overview"
      title="Office payment methods"
      sub="Manage how your office pays THINNR."
      back={{ href: '/payments', label: 'Payments' }}
      allowAnyStaff
      demo={<InlineNotice>Sign in with your office account to manage payment methods.</InlineNotice>}
      live={(ctx) => <PaymentMethodsLive userId={ctx.userId} />}
      accessLive={(userId) => <PaymentMethodsLive userId={userId} />}
    />
  );
}

function PaymentMethodsLive({ userId }: { userId: string }) {
  const access = useOfficeAccess(userId);
  const [editing, setEditing] = useState<OfficeAccessSlot | null>(null);
  const [intent, setIntent] = useState<Awaited<ReturnType<typeof officeBilling.accessSetupIntent>> | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const start = useOfficeBillingMutation(userId, (slot: OfficeAccessSlot, scope) =>
    officeBilling.accessSetupIntent(slot, scope), {
      invalidate: false,
      onSuccess: (value) => setIntent(value),
      onError: (error) => setNotice({ tone: 'bad', text: error.message }),
    });
  const save = useOfficeBillingMutation(userId, (
    input: { slot: OfficeAccessSlot; paymentMethodId: string; setupIntentId: string },
    scope,
  ) => officeBilling.accessInstrument(input, scope), {
    onSuccess: () => {
      setEditing(null);
      setIntent(null);
      setNotice({ tone: 'good', text: 'Payment method updated.' });
    },
    onError: (error) => {
      const duplicate = error instanceof OfficeBillingError &&
        error.status === 409 && error.code === 'duplicate_card';
      setNotice({
        tone: 'bad',
        text: duplicate
          ? 'That card is already on file. The primary and backup cards must be different.'
          : error.message,
      });
    },
  });
  const verify = useOfficeBillingMutation(userId, (_: void, scope) =>
    officeBilling.accessVerifyBank(scope), {
      onSuccess: ({ verified }) => setNotice({
        tone: verified ? 'good' : 'warn',
        text: verified ? 'Bank account verified.' : 'Stripe has not finished verifying this bank account yet.',
      }),
      onError: (error) => setNotice({ tone: 'bad', text: error.message }),
    });
  const pay = useOfficeBillingMutation(userId, (_: void, scope) =>
    officeBilling.accessPay(scope), {
      onSuccess: ({ status }) => setNotice({
        tone: status === 'succeeded' ? 'good' : 'warn',
        text: status === 'succeeded' ? 'Outstanding balance paid.' : `Payment status: ${status.replace(/_/g, ' ')}.`,
      }),
      onError: (error) => setNotice({ tone: 'bad', text: error.message }),
    });

  if (access.isPending) return <LoadingBox label="Loading payment methods…" testID="office-access-loading" />;
  if (access.isError || !access.data) {
    return <InlineNotice tone="bad" testID="office-access-error">{access.error?.message ?? 'Payment methods could not be loaded.'}</InlineNotice>;
  }
  const snapshot = access.data;
  return (
    <>
      {notice ? <InlineNotice tone={notice.tone} testID="office-access-notice">{notice.text}</InlineNotice> : null}
      {(['bank', 'card_primary', 'card_backup'] as const).map((slot) => (
        <InstrumentPanel
          key={slot}
          slot={slot}
          snapshot={snapshot}
          editing={editing === slot}
          busy={start.isPending || save.isPending}
          onEdit={() => { setEditing(slot); setIntent(null); setNotice(null); start.mutate(slot); }}
        >
          {editing === slot && intent?.slot === slot ? (
            <OfficeAccessCardForm
              intent={intent}
              onConfirmed={(paymentMethodId) => save.mutateAsync({
                slot,
                paymentMethodId,
                setupIntentId: intent.setupIntentId,
              }).then(() => undefined)}
            />
          ) : null}
        </InstrumentPanel>
      ))}
      {snapshot.bank.verificationPending ? (
        <Panel title="Verify bank account" sub="Finish Stripe's secure microdeposit check.">
          <View style={styles.actions}>
            {snapshot.bank.verificationUrl ? (
              <Button
                label="Open Stripe verification"
                testID="button-open-bank-verification"
                onPress={() => void Linking.openURL(snapshot.bank.verificationUrl!)}
              />
            ) : null}
            <Button label="I've finished — check again" testID="button-verify-bank" busy={verify.isPending} onPress={() => verify.mutate()} />
          </View>
        </Panel>
      ) : null}
      {snapshot.balance.outstanding ? (
        <Panel title="Outstanding balance" sub={`${formatCents(snapshot.balance.amountCents)} is due to THINNR.`}>
          <Button label={`Pay ${formatCents(snapshot.balance.amountCents)}`} testID="button-pay-office-balance" variant="primary" busy={pay.isPending} onPress={() => pay.mutate()} />
        </Panel>
      ) : null}
    </>
  );
}

function InstrumentPanel({ slot, snapshot, editing, busy, onEdit, children }: {
  slot: OfficeAccessSlot;
  snapshot: OfficeAccessSnapshot;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  const instrument = snapshot.instruments.find((item) => item.slot === slot);
  const value = instrument
    ? instrument.kind === 'card'
      ? `${instrument.brand?.toUpperCase() ?? 'Card'} •••• ${instrument.last4}`
      : `${instrument.bankName ?? 'Bank account'} •••• ${instrument.last4}`
    : 'Not on file';
  return (
    <Panel
      title={SLOT_LABEL[slot]}
      action={instrument ? <StatusPill tone={instrument.verificationStatus === 'failed' ? 'bad' : instrument.verificationStatus === 'pending' ? 'warn' : 'good'}>{instrument.verificationStatus}</StatusPill> : undefined}
    >
      <DetailList items={[
        { label: 'On file', value },
        ...(instrument?.kind === 'card' ? [{ label: 'Expires', value: `${instrument.expMonth}/${instrument.expYear}` }] : []),
      ]} />
      <Button
        label={`${instrument ? 'Replace' : 'Add'} ${slot === 'bank' ? 'bank account' : 'card'}`}
        testID={`button-replace-${slot}`}
        busy={busy && editing}
        disabled={!snapshot.canManage}
        onPress={onEdit}
      />
      {children}
    </Panel>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 8 },
});