import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { Divider, EmptyState, LedgerCard, SectionHeader, StatusBadge } from '@/components/ui/LedgerPrimitives';
import { MOCK_PRODUCTS } from '@/data/mock-data';
import { useOperations } from '@/context/OperationsContext';

/** Matches the soft card shadow used by the shared Heritage primitives. */
const CARD_SHADOW_SOFT = '0 6px 15px rgba(40, 55, 74, 0.06)';

type SubStatus = 'all' | 'active' | 'paused' | 'overdue';

const STATUS_OPTIONS: { label: string; value: SubStatus }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
  { label: 'Overdue', value: 'overdue' },
];

export default function SubscriptionsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hydrated, mergedPatients, mergedSubscriptions } = useOperations();
  const [statusFilter, setStatusFilter] = useState<SubStatus>('all');
  const [query, setQuery] = useState('');
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  // Summary metrics from merged subscriptions
  const activeSubs = mergedSubscriptions.filter(s => s.status === 'active').length;
  const actionNeeded = mergedSubscriptions.filter(s => s.status === 'overdue' || s.paymentStatus === 'failed').length;
  const sevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const upcoming = mergedSubscriptions.filter(s => new Date(s.nextShipment).getTime() < sevenDays && s.status === 'active').length;

  const filteredSubs = useMemo(() => {
    return mergedSubscriptions.filter(sub => {
      const patient = mergedPatients.find(p => p.id === sub.patientId);
      const q = query.trim().toLowerCase();
      const matchQuery = !q || patient?.name.toLowerCase().includes(q) || sub.id.toLowerCase().includes(q);
      const matchStatus = statusFilter === 'all' || sub.status === statusFilter;
      return matchQuery && matchStatus;
    });
  }, [mergedSubscriptions, mergedPatients, query, statusFilter]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Subscriptions" />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.cobalt} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Subscriptions" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
        testID="subscriptions-scroll"
      >
        {/* Summary metrics */}
        <View style={styles.summaryGrid}>
          <LedgerCard style={styles.summaryCard}>
            <View style={[styles.summaryIcon, { backgroundColor: colors.activeBg }]}>
              <Feather name="check-circle" size={20} color={colors.cobalt} />
            </View>
            <Text style={[styles.summaryLabel, { color: colors.labelText }]}>ACTIVE SUBS</Text>
            <Text style={[styles.summaryValue, { color: colors.navy }]}>{activeSubs}</Text>
          </LedgerCard>
          <LedgerCard style={styles.summaryCard}>
            <View style={[styles.summaryIcon, { backgroundColor: colors.riskBg }]}>
              <Feather name="alert-circle" size={20} color={colors.riskText} />
            </View>
            <Text style={[styles.summaryLabel, { color: colors.labelText }]}>ACTION NEEDED</Text>
            <Text style={[styles.summaryValue, { color: colors.riskText }]}>{actionNeeded}</Text>
          </LedgerCard>
          <LedgerCard style={styles.summaryCard}>
            <View style={[styles.summaryIcon, { backgroundColor: colors.orangeBg }]}>
              <Feather name="package" size={20} color={colors.orange} />
            </View>
            <Text style={[styles.summaryLabel, { color: colors.labelText }]}>UPCOMING</Text>
            <Text style={[styles.summaryValue, { color: colors.navy }]}>{upcoming}</Text>
          </LedgerCard>
        </View>

        {/* Product catalog */}
        <View style={styles.catalogSection}>
          <LedgerCard>
            <View style={[styles.catalogHeader, { borderBottomColor: colors.border }]}>
              <SectionHeader
                label="THINNR Catalog"
                value="Products in monthly delivery plans"
              />
              <Text style={[styles.catalogSubtitle, { color: colors.subtleText }]}>
                Public product imagery and source-aligned descriptions from THINNR. Mock pricing.
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catalogScroll}>
              {MOCK_PRODUCTS.map(product => (
                <View
                  key={product.id}
                  style={[styles.productCard, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}
                >
                  <View style={[styles.productImageBox, { backgroundColor: colors.card, borderColor: colors.divider }]}>
                    <Image
                      source={{ uri: product.imageUrl }}
                      style={{ width: '100%', height: '100%' }}
                      contentFit="contain"
                      onError={() => {}}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.productNameRow}>
                      <Text style={[styles.productName, { color: colors.navy }]}>{product.name}</Text>
                      <Text style={[styles.productPrice, { color: colors.cobalt }]}>${product.price}/mo</Text>
                    </View>
                    <Text style={[styles.productDesc, { color: colors.bodyText }]} numberOfLines={3}>{product.description}</Text>
                    <Text style={[styles.productCat, { color: colors.subtleText }]}>{product.category.toUpperCase()}</Text>
                    {product.disclaimer && (
                      <Text style={[styles.productDisclaimer, { color: colors.subtleText }]} numberOfLines={2}>
                        {product.disclaimer}
                      </Text>
                    )}
                  </View>
                </View>
              ))}
            </ScrollView>
            <View style={[styles.catalogFooter, { borderTopColor: colors.divider }]}>
              <Text style={[styles.catalogDisclaimerText, { color: colors.subtleText }]}>
                *Homeopathic claims follow traditional homeopathic principles and have not been evaluated by the FDA. **These statements have not been evaluated by the FDA. This synthetic operations demo does not provide medical advice.
              </Text>
            </View>
          </LedgerCard>
        </View>

        {/* Subscription list filters */}
        <View style={styles.listSection}>
          <View style={[styles.listToolbar, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
            <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="search" size={14} color={colors.subtleText} />
              <TextInput
                testID="subscriptions-search-input"
                placeholder="Search patient or ID..."
                placeholderTextColor={colors.subtleText}
                value={query}
                onChangeText={setQuery}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery('')}>
                  <Feather name="x" size={13} color={colors.subtleText} />
                </Pressable>
              )}
            </View>

            <View style={styles.chipRow}>
              {STATUS_OPTIONS.map(opt => {
                const active = statusFilter === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    testID={`sub-filter-${opt.value}`}
                    onPress={() => { Haptics.selectionAsync(); setStatusFilter(opt.value); }}
                    style={[
                      styles.chip,
                      { backgroundColor: active ? colors.cobalt : colors.card, borderColor: active ? colors.cobalt : colors.border },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.bodyText }]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {filteredSubs.length === 0 ? (
            <EmptyState
              icon={<Feather name="package" size={28} color={colors.subtleText} />}
              title="No subscriptions match"
              body="Try adjusting your search or filter."
            />
          ) : (
            filteredSubs.map((sub, idx) => {
              const patient = mergedPatients.find(p => p.id === sub.patientId);
              const isFailed = sub.paymentStatus === 'failed';
              const nextShipment = new Date(sub.nextShipment).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

              return (
                <View key={sub.id}>
                  {idx > 0 && <Divider />}
                  <Pressable
                    testID={`sub-card-${sub.id}`}
                    onPress={() => {
                      Haptics.selectionAsync();
                      if (patient) router.push(`/patient/${patient.id}`);
                    }}
                    style={({ pressed }) => [
                      styles.subRow,
                      { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border },
                    ]}
                  >
                    <View style={styles.subTop}>
                      <View>
                        <Text style={[styles.subPatient, { color: colors.navy }]}>{patient?.name}</Text>
                        <Text style={[styles.subId, { color: colors.subtleText }]}>{sub.id}</Text>
                      </View>
                      <View style={styles.subTopRight}>
                        <StatusBadge status={sub.status} />
                        {isFailed && (
                          <View style={styles.failedRow}>
                            <Feather name="alert-circle" size={11} color={colors.riskText} />
                            <Text style={[styles.failedText, { color: colors.riskText }]}>Payment Failed</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <View style={styles.subMeta}>
                      <View style={styles.subMetaItem}>
                        <Text style={[styles.subMetaLabel, { color: colors.labelText }]}>MONTHLY VALUE</Text>
                        <Text style={[styles.subMetaValue, { color: colors.navy }]}>${sub.monthlyValue}</Text>
                      </View>
                      <View style={styles.subMetaItem}>
                        <Text style={[styles.subMetaLabel, { color: colors.labelText }]}>NEXT SHIPMENT</Text>
                        <Text style={[styles.subMetaValue, { color: colors.bodyText }]}>{nextShipment}</Text>
                      </View>
                      <View style={styles.subMetaItem}>
                        <Text style={[styles.subMetaLabel, { color: colors.labelText }]}>CADENCE</Text>
                        <Text style={[styles.subMetaValue, { color: colors.bodyText }]}>{sub.cadence}</Text>
                      </View>
                    </View>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>

        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryGrid: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 10, gap: 8 },
  summaryCard: { flex: 1, padding: 12, gap: 6 },
  summaryIcon: { width: 36, height: 36, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center' },
  summaryLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 1, fontFamily: 'Inter_700Bold' },
  summaryValue: { fontSize: 22, fontWeight: '600', fontFamily: 'Inter_600SemiBold', letterSpacing: -0.5 },
  catalogSection: { paddingHorizontal: 14, paddingBottom: 12 },
  catalogHeader: { padding: 16, borderBottomWidth: 1 },
  catalogSubtitle: { fontSize: 11, marginTop: 4, fontFamily: 'Inter_400Regular' },
  catalogScroll: { paddingHorizontal: 16, paddingVertical: 14 },
  productCard: { width: 160, borderWidth: 1, borderRadius: theme.radius, padding: 10, marginRight: 10, gap: 8 },
  productImageBox: { height: 80, borderWidth: 1, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  productNameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 },
  productName: { fontSize: 13, fontFamily: fonts.serif, flex: 1 },
  productPrice: { fontSize: 11, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  productDesc: { fontSize: 10, lineHeight: 14, fontFamily: 'Inter_400Regular', marginTop: 3 },
  productCat: { fontSize: 8, fontWeight: '700', letterSpacing: 1, fontFamily: 'Inter_700Bold', marginTop: 4 },
  productDisclaimer: { fontSize: 8, fontFamily: 'Inter_400Regular', marginTop: 3, lineHeight: 11 },
  catalogFooter: { borderTopWidth: 1, padding: 12 },
  catalogDisclaimerText: { fontSize: 9, fontFamily: 'Inter_400Regular', lineHeight: 13 },
  listSection: { paddingHorizontal: 14, paddingBottom: 0, gap: 0 },
  listToolbar: { borderWidth: 1, borderRadius: theme.radius, padding: 12, marginBottom: 10, gap: 8 },
  searchBox: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 10, paddingVertical: 7, gap: 8 },
  searchInput: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderRadius: theme.radiusSm },
  chipText: { fontSize: 10, fontWeight: '700', fontFamily: 'Inter_700Bold', letterSpacing: 0.4 },
  subRow: { padding: 14, borderWidth: 1, borderRadius: theme.radius, marginBottom: 8, boxShadow: CARD_SHADOW_SOFT },
  subTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  subPatient: { fontSize: 15, fontFamily: fonts.serif },
  subId: { fontSize: 9, fontFamily: 'Inter_400Regular', marginTop: 2, letterSpacing: 0.3 },
  subTopRight: { alignItems: 'flex-end', gap: 4 },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  failedText: { fontSize: 10, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  subMeta: { flexDirection: 'row', gap: 16 },
  subMetaItem: { gap: 3 },
  subMetaLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 0.8, fontFamily: 'Inter_700Bold' },
  subMetaValue: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
});
