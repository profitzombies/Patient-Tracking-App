/**
 * FavoriteStar — compact star toggle for food and recipe rows. Reads and
 * writes favorites through PatientContext so any list row can pin an item
 * to the Add Food "Favorites" scope for one-tap logging. Visual language
 * matches the recipe-card star button (cobalt fill when active).
 */
import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';

interface FavoriteStarProps {
  /** Library id stored in favorites — a food id or recipe id. */
  id: string;
  /** Item name, used for the accessibility label. */
  name: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Lets catalog rows atomically promote a snapshot before favoriting. */
  onToggle?: () => void | Promise<void>;
}

export function FavoriteStar({ id, name, testID, style, onToggle }: FavoriteStarProps) {
  const colors = useColors();
  const patient = usePatient();
  const isFav = patient.favorites.includes(id);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: isFav }}
      accessibilityLabel={isFav ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      onPress={() => void (onToggle ? onToggle() : patient.toggleFavorite(id))}
      hitSlop={6}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: isFav ? colors.cobalt : pressed ? colors.accent : colors.card,
          borderColor: isFav ? colors.cobalt : colors.border,
          borderRadius: colors.radiusSm,
        },
        style,
      ]}
    >
      <Feather name="star" size={13} color={isFav ? colors.primaryForeground : colors.bodyText} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 26,
    height: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
