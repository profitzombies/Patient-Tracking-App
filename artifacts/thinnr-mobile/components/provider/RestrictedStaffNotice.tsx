/**
 * What a restricted office sees instead of a blocked staff screen.
 *
 * Non-punitive and specific: the account is unpaid, this area waits, these
 * areas still work, and the payment is one tap away. Nothing here scolds and
 * nothing here is a dead end.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { PageScrollView } from '@/components/ui/PageScrollView';
import { Body, Button, Panel } from '@/components/payments/primitives';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { useOfficeRestriction } from '@/context/OfficeRestrictionContext';
import { OFFICE_ACCESS_ROUTE, OFFICE_RESTRICTED_STAFF_MESSAGE } from '@/lib/office-restriction';

export function RestrictedStaffNotice() {
  const colors = useColors();
  const { message } = useOfficeRestriction();
  return (
    <PageScrollView contentContainerStyle={styles.page} testID="screen-office-restricted">
      <View style={[styles.badge, { backgroundColor: colors.accent }]}>
        <Feather name="alert-circle" size={20} color={colors.cobalt} />
      </View>
      <Text style={[styles.title, { color: colors.navy }]}>This part of THINNR is paused</Text>
      <Body testID="text-restricted-message" style={styles.lead}>
        {message ?? OFFICE_RESTRICTED_STAFF_MESSAGE}
      </Body>
      <Body style={styles.lead}>
        Nothing has been deleted, and your patients keep using their app. Everything returns the
        moment the account is paid.
      </Body>
      <Panel title="Still open">
        <Body testID="text-restricted-allowed">
          Patient subscriptions, payments and payouts, and patient data export.
        </Body>
      </Panel>
      <View style={styles.actions}>
        <Button
          label="Pay now"
          variant="primary"
          testID="button-restricted-pay"
          onPress={() => router.replace(OFFICE_ACCESS_ROUTE)}
        />
        <Button
          label="Patient subscriptions"
          testID="button-restricted-subscriptions"
          onPress={() => router.replace('/payments/subscriptions')}
        />
      </View>
    </PageScrollView>
  );
}

const styles = StyleSheet.create({
  page: { gap: 12, paddingHorizontal: 18, paddingVertical: 28 },
  badge: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.serifBold, fontSize: 22, letterSpacing: -0.2 },
  lead: { fontSize: 13, lineHeight: 20 },
  actions: { gap: 10, marginTop: 6 },
});
