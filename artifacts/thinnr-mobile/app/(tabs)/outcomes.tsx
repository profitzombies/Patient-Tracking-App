import React, { useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import {
  Divider,
  LedgerCard,
  PillSelector,
  ProgressBar,
  SectionHeader,
} from '@/components/ui/LedgerPrimitives';
import { MOCK_ANALYTICS, MOCK_PROVIDERS } from '@/data/mock-data';

type Range = 'Last 30 Days' | 'Last 6 Months' | 'Year to Date';

const RANGE_SCALES: Record<Range, number> = {
  'Last 30 Days': 1,
  'Last 6 Months': 5.6,
  'Year to Date': 10.8,
};

const RANGE_OPTIONS: { label: string; value: Range }[] = [
  { label: '30 Days', value: 'Last 30 Days' },
  { label: '6 Months', value: 'Last 6 Months' },
  { label: 'YTD', value: 'Year to Date' },
];

export default function OutcomesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<Range>('Year to Date');
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const scale = RANGE_SCALES[range];
  const totalRevenue = Math.round(MOCK_ANALYTICS.monthlyRevenue * scale);
  const recurringRevenue = Math.round(MOCK_ANALYTICS.recurringRevenue * scale);
  const enrollmentRevenue = Math.round(MOCK_ANALYTICS.enrollmentRevenue * scale);

  const handleExport = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const rows = [
      ['Period', range],
      ['Total Revenue', totalRevenue],
      ['Recurring Subscriptions', recurringRevenue],
      ['New Enrollments', enrollmentRevenue],
      ['Average Pounds Lost', MOCK_ANALYTICS.averagePoundsLost],
      ['Average Goal Completion', MOCK_ANALYTICS.averageGoalCompletion],
      ['Protocol Retention', MOCK_ANALYTICS.retention],
    ];
    const text = rows.map(r => r.join(': ')).join('\n');
    const csv = rows.map(r => r.join(',')).join('\n');

    if (Platform.OS === 'web') {
      // web: offer CSV download
      try {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `thinnr-outcomes-${range.toLowerCase().replace(/ /g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        Alert.alert('Export', text);
      }
    } else {
      await Share.share({
        title: `THINNR Outcomes — ${range}`,
        message: text,
      });
    }
  };

  const sortedProviders = [...MOCK_PROVIDERS].sort((a, b) => b.averageOutcomes - a.averageOutcomes);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Outcomes" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
        testID="outcomes-scroll"
      >
        {/* Range + export row */}
        <View style={styles.rangeRow}>
          <PillSelector
            options={RANGE_OPTIONS}
            selected={range}
            onSelect={setRange}
            style={{ flex: 1 }}
          />
          <Pressable
            testID="outcomes-export-btn"
            onPress={handleExport}
            style={({ pressed }) => [
              styles.exportBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            ]}
          >
            <Feather name="download" size={16} color={colors.bodyText} />
          </Pressable>
        </View>

        {/* Revenue cards */}
        <View style={styles.pad}>
          <Text style={[styles.pageTitle, { color: colors.navy }]}>Revenue & Outcomes</Text>
          <Text style={[styles.pageSubtitle, { color: colors.bodyText }]}>Synthetic practice performance and cohort analysis.</Text>
        </View>

        <View style={[styles.pad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Total Revenue" />
            <Text style={[styles.bigNumber, { color: colors.navy }]}>${totalRevenue.toLocaleString()}</Text>
            <View style={[styles.changeRow, { marginBottom: 16 }]}>
              <View style={[styles.changeBadge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                <Feather name="arrow-up-right" size={11} color={colors.cobalt} />
                <Text style={[styles.changeText, { color: colors.cobalt }]}>12.4%</Text>
              </View>
            </View>
            <Divider />
            <View style={[styles.breakdownRow, { marginTop: 12 }]}>
              <Text style={[styles.breakdownLabel, { color: colors.bodyText }]}>Recurring Subscriptions</Text>
              <Text style={[styles.breakdownValue, { color: colors.navy }]}>${recurringRevenue.toLocaleString()}</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={[styles.breakdownLabel, { color: colors.bodyText }]}>New Enrollments</Text>
              <Text style={[styles.breakdownValue, { color: colors.navy }]}>${enrollmentRevenue.toLocaleString()}</Text>
            </View>
          </LedgerCard>
        </View>

        {/* Outcome summary */}
        <View style={[styles.pad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Demo Outcome Summary" />
            <Text style={[styles.bigNumber, { color: colors.navy }]}>{MOCK_ANALYTICS.averageGoalCompletion}%</Text>
            <Text style={[styles.bigNumberLabel, { color: colors.bodyText }]}>Avg Goal Completion</Text>
            <Divider style={{ marginVertical: 12 }} />
            <View style={styles.breakdownRow}>
              <Text style={[styles.breakdownLabel, { color: colors.bodyText }]}>Avg Weight Loss</Text>
              <Text style={[styles.breakdownValue, { color: colors.navy }]}>{MOCK_ANALYTICS.averagePoundsLost} lbs</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={[styles.breakdownLabel, { color: colors.bodyText }]}>Protocol Retention</Text>
              <Text style={[styles.breakdownValue, { color: colors.navy }]}>{MOCK_ANALYTICS.retention}%</Text>
            </View>
          </LedgerCard>
        </View>

        {/* Growth opportunity */}
        <View style={[styles.pad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <View style={styles.opportunityRow}>
              <View style={[styles.opportunityIcon, { backgroundColor: colors.orangeBg }]}>
                <Feather name="target" size={18} color={colors.orange} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.opportunityTitle, { color: colors.navy }]}>Growth Opportunity</Text>
                <Text style={[styles.opportunityBody, { color: colors.bodyText }]}>
                  Maintenance stack conversions are up 14% this month. Recommend focusing on Week 5 cohort.
                </Text>
              </View>
            </View>
          </LedgerCard>
        </View>

        {/* Cohort outcomes */}
        <View style={[styles.pad, { paddingTop: 0 }]}>
          <LedgerCard>
            <View style={[styles.tableHeader, { borderBottomColor: colors.border }]}>
              <SectionHeader label="Cohort Outcomes" />
            </View>
            {/* Header row */}
            <View style={[styles.tableRowHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.thText, { color: colors.labelText, flex: 2 }]}>COHORT</Text>
              <Text style={[styles.thText, { color: colors.labelText, flex: 1 }]}>AVG LBS</Text>
              <Text style={[styles.thText, { color: colors.labelText, flex: 1 }]}>RETENTION</Text>
              <Text style={[styles.thText, { color: colors.labelText, flex: 1 }]}>PERF</Text>
            </View>
            {MOCK_ANALYTICS.cohortOutcomes.map((cohort, idx) => (
              <View key={cohort.month}>
                {idx > 0 && <Divider />}
                <View style={styles.tableRow}>
                  <Text style={[styles.tdBold, { color: colors.navyLight, flex: 2 }]}>2024 — {cohort.month}</Text>
                  <Text style={[styles.tdMono, { color: colors.bodyText, flex: 1 }]}>{cohort.avgLost}</Text>
                  <Text style={[styles.tdMono, { color: colors.bodyText, flex: 1 }]}>{cohort.retention}%</Text>
                  <View style={{ flex: 1 }}>
                    <ProgressBar value={cohort.retention} />
                  </View>
                </View>
              </View>
            ))}
          </LedgerCard>
        </View>

        {/* Provider performance */}
        <View style={[styles.pad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Provider Outcomes" />
            <View style={{ marginTop: 16, gap: 16 }}>
              {sortedProviders.map(provider => (
                <View key={provider.id}>
                  <View style={styles.providerRow}>
                    <Text style={[styles.providerName, { color: colors.navy }]}>{provider.name}</Text>
                    <Text style={[styles.providerStat, { color: colors.bodyText }]}>
                      {provider.averageOutcomes}% goal · {provider.activePatientCount} pts
                    </Text>
                  </View>
                  <ProgressBar value={provider.averageOutcomes} color={colors.cobaltLight} style={{ marginTop: 6 }} />
                </View>
              ))}
            </View>
          </LedgerCard>
        </View>

        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 8,
  },
  exportBtn: {
    width: 38,
    height: 38,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pad: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  pageTitle: {
    fontSize: 24,
    fontFamily: fonts.serifBold,
    letterSpacing: -0.2,
  },
  pageSubtitle: {
    fontSize: 13,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  bigNumber: {
    fontSize: 32,
    fontFamily: fonts.serif,
    letterSpacing: -0.4,
    marginTop: 8,
  },
  bigNumberLabel: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  changeRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  changeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 3,
  },
  changeText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  breakdownLabel: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  breakdownValue: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  opportunityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  opportunityIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  opportunityTitle: {
    fontSize: 15,
    fontFamily: fonts.serif,
  },
  opportunityBody: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  tableHeader: {
    padding: 16,
    borderBottomWidth: 1,
  },
  tableRowHeader: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  thText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  tdBold: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  tdMono: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  providerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  providerName: {
    fontSize: 14,
    fontFamily: fonts.serif,
    flex: 1,
  },
  providerStat: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
});
