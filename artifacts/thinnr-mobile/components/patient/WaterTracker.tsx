/**
 * Water tracker, Heritage style: an icon + serif "Water" header with the
 * running total, a row of flat tappable 8 oz segments, and fine-grained
 * +/− controls. Tapping segment N fills through N; tapping the last filled
 * segment empties it (same behavior as before — presentation only changed).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { WATER_CUP_OZ } from '@/data/patient-data';

// Reference water-segment inks — no semantic token exists for these fills.
const SEGMENT_FILLED = '#6e9bc8';
const SEGMENT_EMPTY = '#e5edf3';

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
      <View style={styles.headerRow}>
        <View
          style={[
            styles.iconBox,
            { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
          ]}
        >
          <Feather name="droplet" size={16} color={colors.cobalt} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Water</Text>
          <Text style={[styles.meta, { color: colors.subtleText }]}>
            {oz} of {targetOz} fl oz · {filled} of {cupCount} cups
          </Text>
        </View>
        <View style={styles.adjustRow}>
          <Pressable
            testID="water-minus"
            onPress={() => patient.setWater(dateKey, oz - WATER_CUP_OZ)}
            style={({ pressed }) => [
              styles.adjustBtn,
              {
                borderColor: colors.border,
                borderRadius: colors.radiusSm,
                backgroundColor: pressed ? colors.accent : colors.card,
              },
            ]}
          >
            <Feather name="minus" size={14} color={colors.bodyText} />
          </Pressable>
          <Pressable
            testID="water-plus"
            onPress={() => patient.setWater(dateKey, oz + WATER_CUP_OZ)}
            style={({ pressed }) => [
              styles.adjustBtn,
              {
                borderColor: colors.border,
                borderRadius: colors.radiusSm,
                backgroundColor: pressed ? colors.accent : colors.card,
              },
            ]}
          >
            <Feather name="plus" size={14} color={colors.bodyText} />
          </Pressable>
        </View>
      </View>
      <View style={styles.segmentRow}>
        {Array.from({ length: cupCount }).map((_, index) => {
          const isFilled = index < filled;
          return (
            <Pressable
              key={index}
              testID={`water-cup-${index}`}
              onPress={() => handleCupPress(index)}
              style={({ pressed }) => [
                styles.segment,
                { backgroundColor: isFilled ? SEGMENT_FILLED : SEGMENT_EMPTY },
                pressed && { opacity: 0.8 },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBox: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 17,
    fontFamily: fonts.serif,
  },
  meta: {
    fontSize: 11,
    marginTop: 1,
    fontFamily: fonts.sans,
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
  segmentRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
  },
  segment: {
    flex: 1,
    height: 20,
  },
});
