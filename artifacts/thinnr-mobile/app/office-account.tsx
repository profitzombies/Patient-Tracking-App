/**
 * Account & billing — the office's own THINNR access, in the provider app.
 *
 * Shows what the office owes and lets ANY staff member pay it. Stays usable
 * while the workspace is narrowed for nonpayment: this is where the narrowed
 * app sends staff, and the payment here is what lifts the restriction.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { PageScrollView } from '@/components/ui/PageScrollView';
import { Body, Button, DetailList, ErrorBox, LoadingBox, Panel, DemoNotice } from '@/components/payments/primitives';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { useSupabaseSession } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/office-billing-format';
import { useOfficeRestriction, usePayOfficeAccess } from '@/context/OfficeRestrictionContext';
import type { OfficeAccessState } from '@/lib/office-access-api';

const STATE_LABELS: Record<string, string> = {
  included: 'Included period',
  active: 'Paid and active',
  grace: 'Payment overdue',
  restricted: 'Access narrowed for nonpayment',
  cancelled: 'Cancelled',
};

export default function OfficeAccountScreen() {
  const colors = useColors();
  const { session, sessionLoading } = useSupabaseSession();
  const { access, loading } = useOfficeRestriction();

  return (
    <PageScrollView contentContainerStyle={styles.page} testID="screen-office-account">
      <View>
        <Text style={[styles.title, { color: colors.navy }]} testID="text-office-account-title">
          Account &amp; billing
        </Text>
        <Body style={styles.sub}>Your office&rsquo;s subscription to the THINNR platform.</Body>
      </View>
      {sessionLoading ? (
        <LoadingBox label="Checking your sign-in…" testID="office-account-session-loading" />
      ) : !session?.user ? (
        <DemoNotice />
      ) : loading ? (
        <LoadingBox label="Loading your account…" testID="office-account-loading" />
      ) : (
        <AccessPanel access={access} />
      )}
      <Button label="Back" testID="button-office-account-back" onPress={() => router.back()} />
    </PageScrollView>
  );
}

function AccessPanel({ access }: { access: OfficeAccessState | undefined }) {
  const pay = usePayOfficeAccess();
  const result = pay.data;
  return (
    <>
      <Panel title="THINNR access" testID="panel-office-access">
        <DetailList
          items={[
            { label: 'Status', value: access?.state ? STATE_LABELS[access.state] ?? access.state : '—' },
            {
              label: 'Amount',
              value: access?.lifetime
                ? 'Lifetime access'
                : `${formatCents(access?.price_cents ?? 0)}${access?.plan ? ` / ${access.plan === 'yearly' ? 'year' : 'month'}` : ''}`,
            },
            { label: 'Paid through', value: access?.paid_through ? formatDate(access.paid_through) : '—' },
            { label: 'Recovery window ends', value: access?.grace_ends_at ? formatDate(access.grace_ends_at) : '—' },
          ]}
        />
        <Button
          label={pay.isPending ? 'Charging…' : 'Pay now'}
          variant="primary"
          busy={pay.isPending}
          testID="button-pay-office-access"
          onPress={() => pay.mutate()}
        />
        {pay.isError ? <ErrorBox error={pay.error} testID="office-access-pay-error" /> : null}
        {result?.paid ? (
          <Body testID="text-pay-success" muted={false}>Payment received — full access is restored.</Body>
        ) : null}
        {result?.pending ? (
          <Body testID="text-pay-pending">Your payment is processing. Access opens as soon as it settles.</Body>
        ) : null}
      </Panel>
      {access?.restricted ? (
        <Panel title="Still open" testID="panel-office-access-allowed">
          <Body>Patient subscriptions, payments and payouts, and patient data export.</Body>
        </Panel>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  page: { gap: 12, paddingHorizontal: 18, paddingVertical: 26 },
  title: { fontFamily: fonts.serifBold, fontSize: 24, letterSpacing: -0.2 },
  sub: { marginTop: 4, fontSize: 13, lineHeight: 19 },
});
