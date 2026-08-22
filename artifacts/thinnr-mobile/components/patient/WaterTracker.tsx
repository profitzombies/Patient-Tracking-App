/**
 * Water tracker — a row of square 8 oz cups plus fine-grained +/− controls.
 * Tapping cup N fills through N; tapping the last filled cup empties it.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';
import { WATER_CUP_OZ } from '@/data/patient-data';

interface WaterTrackerProps {
  dateKey: string;
}

export function WaterTracker({ dateKey }: WaterTrackerProps) {
  const colors = useColors();
  const patient = usePatient();
  const oz = patient.waterFor(dateKey);
  const targetOz = patient.targets.waterOz;
  const cupCount = Math.max(8, Math.ceil(targetOz / WATER_CUP_OZ));
  const filled = Math.floor(oz / WATER_CUP_OZ);

  const handleCupPress = (index: number) => {
    const tappedFilledEdge = index === filled - 1;
    const nextCups = tappedFilledEdge ? index : index + 1;
    patient.setWater(dateKey, nextCups * WATER_CUP_OZ);
  };

  return (
    <View>
      <View style={styles.cupRow}>
        {Array.from({ length: cupCount }).map((_, index) => {
          const isFilled = index < filled;
          return (
            <Pressable
              key={index}
              testID={`water-cup-${index}`}
              onPress={() => handleCupPress(index)}
              style={({ pressed }) => [
                styles.cup,
                {
                  backgroundColor: isFilled ? colors.cobalt : colors.paperCardAlt,
                  borderColor: isFilled ? colors.cobalt : colors.border,
                },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Feather
                name="droplet"
                size={14}
                color={isFilled ? colors.primaryForeground : colors.cobaltMuted}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.footerRow}>
        <Text style={[styles.totalText, { color: colors.navyLight }]}>
          {oz}
          <Text style={{ color: colors.subtleText }}> of {targetOz} fl oz</Text>
        </Text>
        <View style={styles.adjustRow}>
          <Pressable
            testID="water-minus"
            onPress={() => patient.setWater(dateKey, oz - WATER_CUP_OZ)}
            style={({ pressed }) => [
              styles.adjustBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            ]}
          >
            <Feather name="minus" size={14} color={colors.bodyText} />
          </Pressable>
          <Pressable
            testID="water-plus"
            onPress={() => patient.setWater(dateKey, oz + WATER_CUP_OZ)}
            style={({ pressed }) => [
              styles.adjustBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            ]}
          >
            <Feather name="plus" size={14} color={colors.bodyText} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cupRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cup: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  totalText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  adjustRow: {
    flexDirection: 'row',
    gap: 6,
  },
  adjustBtn: {
    width: 28,
    height: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
