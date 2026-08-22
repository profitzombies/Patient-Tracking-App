/**
 * ApprovedBadge — the one consistent checkmark treatment for foods that are
 * approved for the THINNR program. Shown wherever an approved food appears:
 * library browsing, Add Food search results, diary rows, and the Approved
 * Foods list itself. Patient-created foods never receive this badge.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { APPROVED_BADGE_EXPLANATION } from '@/data/approved-foods';

interface ApprovedBadgeProps {
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
}

export function ApprovedBadge({ size = 'sm', style }: ApprovedBadgeProps) {
  const colors = useColors();
  const dim = size === 'sm' ? 14 : 20;
  return (
    <View
      testID="approved-badge"
      accessibilityLabel={APPROVED_BADGE_EXPLANATION}
      style={[
        {
          width: dim,
          height: dim,
          backgroundColor: colors.activeBg,
          borderWidth: 1,
          borderColor: colors.activeBorder,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Feather name="check" size={size === 'sm' ? 10 : 13} color={colors.activeGreen} />
    </View>
  );
}
