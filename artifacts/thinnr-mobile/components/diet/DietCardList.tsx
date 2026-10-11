/**
 * The diet picker's card list: one card per catalog diet showing only the
 * name, plain-language summary and complexity (owner decision), plus the
 * short oversight note where the catalog asks for it. Shared by the
 * onboarding diet step and the full picker; renders with RN primitives only
 * so Node suites can mount it.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import {
  DIET_CATALOG,
  JUST_TRACKING_SLUG,
  OVERSIGHT_NOTE_TEXT,
  type DietCatalogEntry,
  type DietComplexity,
} from '@/lib/diet-fit';

export const COMPLEXITY_LABELS: Record<DietComplexity, string> = {
  simple: 'Simple',
  moderate: 'Moderate',
  advanced: 'Advanced',
};

/** "Just tracking" always leads; everything else keeps the catalog order. */
export function orderedDietEntries(): DietCatalogEntry[] {
  const entries = [...DIET_CATALOG].sort((a, b) => a.sortOrder - b.sortOrder);
  const tracking = entries.filter(e => e.slug === JUST_TRACKING_SLUG);
  return [...tracking, ...entries.filter(e => e.slug !== JUST_TRACKING_SLUG)];
}

interface DietCardListProps {
  value: string | null;
  onSelect: (slug: string) => void;
  /** Slug shown with a "Suggested for you" tag (GLP-1 companion for GLP-1 patients). */
  suggestedSlug?: string | null;
  /** Slug currently in force (shows a "Current" tag). */
  currentSlug?: string | null;
  testIDPrefix?: string;
}

export function DietCardList({ value, onSelect, suggestedSlug, currentSlug, testIDPrefix = 'diet-card' }: DietCardListProps) {
  const colors = useColors();
  return (
    <View style={styles.list}>
      {orderedDietEntries().map(entry => {
        const selected = value === entry.slug;
        return (
          <Pressable
            key={entry.slug}
            testID={`${testIDPrefix}-${entry.slug}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={`${entry.name}. ${COMPLEXITY_LABELS[entry.complexity]}.`}
            onPress={() => onSelect(entry.slug)}
            style={({ pressed }) => [
              styles.card,
              {
                backgroundColor: colors.card,
                borderColor: selected ? colors.cobalt : colors.border,
                borderWidth: selected ? 2 : 1,
                borderRadius: colors.radius,
              },
              pressed && { opacity: 0.9 },
            ]}
          >
            <View style={styles.titleRow}>
              <Text style={[styles.name, { color: colors.navy }]}>{entry.name}</Text>
              <Text style={[styles.complexity, { color: colors.labelText, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
                {COMPLEXITY_LABELS[entry.complexity].toUpperCase()}
              </Text>
            </View>
            <Text style={[styles.summary, { color: colors.bodyText }]}>{entry.summary}</Text>
            {entry.oversightNote ? (
              <Text testID={`${testIDPrefix}-${entry.slug}-oversight`} style={[styles.note, { color: colors.warnText }]}>
                {OVERSIGHT_NOTE_TEXT}
              </Text>
            ) : null}
            {(suggestedSlug === entry.slug || currentSlug === entry.slug) ? (
              <View style={styles.tags}>
                {currentSlug === entry.slug ? (
                  <Text style={[styles.tag, { color: colors.activeGreen, backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>Current</Text>
                ) : null}
                {suggestedSlug === entry.slug && currentSlug !== entry.slug ? (
                  <Text testID={`${testIDPrefix}-${entry.slug}-suggested`} style={[styles.tag, { color: colors.cobalt, backgroundColor: colors.accent, borderColor: colors.activeBorder }]}>
                    Suggested for you
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  card: { padding: 14, gap: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { fontFamily: fonts.sansSemiBold, fontSize: 16, flex: 1 },
  complexity: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 0.6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  summary: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  note: { fontFamily: fonts.sansMedium, fontSize: 12, lineHeight: 16 },
  tags: { flexDirection: 'row', gap: 6 },
  tag: { fontFamily: fonts.sansMedium, fontSize: 11, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
});
