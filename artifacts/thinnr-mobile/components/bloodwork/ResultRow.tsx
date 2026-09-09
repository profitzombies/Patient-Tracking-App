import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { getListBloodworkCorrectionsQueryKey, useListBloodworkCorrections, type BloodworkResult } from '@workspace/api-client-react';
import { useSupabaseSession } from '@/lib/supabase';

function correctionSummary(fields: {
  testName: string | null;
  valueText: string | null;
  units: string | null;
  referenceRange: string | null;
  labFlag: string | null;
  uncertain: boolean;
}): string {
  return [
    fields.testName || 'Unnamed test',
    `${fields.valueText || '—'}${fields.units ? ` ${fields.units}` : ''}`,
    fields.referenceRange ? `range ${fields.referenceRange}` : 'no printed range',
    fields.labFlag ? `printed flag ${fields.labFlag}` : 'no printed flag',
    fields.uncertain ? 'uncertain' : 'not marked uncertain',
  ].join(' · ');
}

interface ResultRowProps {
  result: BloodworkResult;
  patientId: string;
  reportId: string;
  officeId?: string;
  onPress: () => void;
  onViewSource?: (fileId: string, page: number) => void;
}

export function ResultRow({ result, patientId, reportId, officeId, onPress, onViewSource }: ResultRowProps) {
  const colors = useColors();
  const { session } = useSupabaseSession();
  const [expanded, setExpanded] = useState(false);
  
  const isUncertain = result.uncertain;
  const params = officeId ? { office: officeId } : undefined;
  const correctionQueryKey = [
    ...getListBloodworkCorrectionsQueryKey(patientId, reportId, result.id, params),
    session?.user.id ?? '',
  ] as const;

  const { data: correctionsData, isLoading, isError, refetch } = useListBloodworkCorrections(
    patientId,
    reportId,
    result.id,
    params,
    {
      query: { enabled: expanded && result.corrected && !!session?.user.id, queryKey: correctionQueryKey },
      request: { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined },
    }
  );

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.container,
          pressed && { backgroundColor: colors.accent },
        ]}
      >
        <View style={styles.left}>
          <View style={styles.testNameRow}>
            <Text style={[styles.testName, { color: colors.navy }]} numberOfLines={1}>
              {result.testName || 'Unknown Test'}
            </Text>
            {result.corrected && (
              <Feather name="edit-2" size={10} color={colors.subtleText} style={{ marginLeft: 4 }} />
            )}
            {isUncertain && (
              <View style={[styles.uncertainBadge, { backgroundColor: colors.warnText }]}>
                 <Text style={styles.uncertainText}>?</Text>
              </View>
            )}
          </View>
          
          {!!result.labFlag && (
            <Text style={[styles.flag, { color: colors.subtleText }]}>Printed lab flag: {result.labFlag}</Text>
          )}
          {!!result.referenceRange && (
            <Text style={[styles.range, { color: colors.subtleText }]}>Printed range: {result.referenceRange}</Text>
          )}
        </View>

        <View style={styles.right}>
          <Text style={[styles.value, { color: colors.navy }]}>
            {result.valueText || '--'}
          </Text>
          {!!result.units && (
            <Text style={[styles.units, { color: colors.subtleText }]}>{result.units}</Text>
          )}
        </View>
      </Pressable>

      <View style={styles.footerRow}>
        {onViewSource && result.sourcePage ? (
          <Pressable onPress={() => onViewSource(result.sourceFileId, result.sourcePage)} style={styles.footerBtn}>
            <Feather name="file" size={12} color={colors.cobalt} />
            <Text style={[styles.footerText, { color: colors.cobalt }]}>Page {result.sourcePage}</Text>
          </Pressable>
        ) : <View />}

        {result.corrected && (
          <Pressable onPress={() => setExpanded(!expanded)} style={styles.footerBtn}>
            <Text style={[styles.footerText, { color: colors.subtleText }]}>
              {expanded ? 'Hide History' : 'View History'}
            </Text>
            <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.subtleText} />
          </Pressable>
        )}
      </View>

      {expanded && result.corrected && (
        <View style={[styles.historyBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {isLoading ? (
            <ActivityIndicator size="small" color={colors.cobalt} style={{ margin: 12 }} />
          ) : isError ? (
            <Pressable onPress={() => void refetch()}>
              <Text style={[styles.historyEmpty, { color: colors.destructive }]}>Could not load correction history. Tap to retry.</Text>
            </Pressable>
          ) : correctionsData?.corrections.length === 0 ? (
            <Text style={[styles.historyEmpty, { color: colors.subtleText }]}>No corrections found.</Text>
          ) : (
            correctionsData?.corrections.map(c => (
              <View key={c.id} style={styles.correctionRow}>
                <Text style={[styles.cDate, { color: colors.subtleText }]}>
                  {new Date(c.createdAt).toLocaleString()} by {c.actorRole}
                </Text>
                <View style={styles.cChanges}>
                  <Text style={[styles.cValue, { color: colors.riskText, textDecorationLine: 'line-through' }]}>
                    {correctionSummary(c.before)}
                  </Text>
                  <Feather name="arrow-right" size={12} color={colors.subtleText} />
                  <Text style={[styles.cValue, { color: colors.activeGreen }]}>
                    {correctionSummary(c.after)}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    paddingHorizontal: 16,
    minHeight: 48,
  },
  left: {
    flex: 1,
    justifyContent: 'center',
    paddingRight: 16,
  },
  testNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  testName: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  uncertainBadge: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  uncertainText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#fff',
  },
  flag: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: 'Inter_600SemiBold',
  },
  range: { fontSize: 11, marginTop: 2, fontFamily: 'Inter_400Regular' },
  right: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  value: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  units: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
    marginTop: 4,
  },
  footerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 4,
    marginHorizontal: -4,
  },
  footerText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
  historyBox: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  historyEmpty: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  correctionRow: {
    marginBottom: 8,
  },
  cDate: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    marginBottom: 2,
  },
  cChanges: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
  },
  cValue: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
});
