/**
 * Compact recipe suggestion card rendered under a coach reply.
 *
 * Registered into the chat's card slot for kind "recipe" (module side
 * effect — coach-chat.tsx imports this file). Tapping opens the full
 * AI-recipe preview screen, which reads the suggestion from the chat
 * session registry by id. Heritage styling: soft-radius inset card on the
 * paper bubble, serif recipe title, Inter uppercase micro-labels, orange
 * only as the small cravings-tag accent, estimated macros always marked
 * "EST.".
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { registerCoachCard } from '@/components/coach/CoachCardSlot';
import { useColors } from '@/hooks/useColors';
import { parseRecipeCardPayload, type AiRecipeSuggestion } from '@/lib/ai-recipe';

export function RecipeSuggestionCard({ suggestion }: { suggestion: AiRecipeSuggestion }) {
  const colors = useColors();
  const router = useRouter();
  const isCravings = suggestion.mode === 'cravings';

  return (
    <Pressable
      testID={`coach-recipe-card-${suggestion.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open recipe suggestion ${suggestion.name}`}
      onPress={() => {
        Haptics.selectionAsync();
        router.push(`/ai-recipe/${suggestion.id}`);
      }}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: colors.border,
          backgroundColor: colors.background,
          borderRadius: colors.radiusSm,
        },
        pressed && { backgroundColor: colors.accent },
      ]}
    >
      <View style={styles.tagRow}>
        <Text style={[styles.tag, { color: isCravings ? colors.orangeText : colors.cobalt }]}>
          {isCravings ? 'CRAVINGS FIX · APPROVED FOODS ONLY' : 'RECIPE IDEA'}
        </Text>
        <Feather name="chevron-right" size={15} color={colors.subtleText} />
      </View>
      <Text style={[styles.name, { color: colors.navy }]} numberOfLines={2}>
        {suggestion.name}
      </Text>
      <Text style={[styles.description, { color: colors.bodyText }]} numberOfLines={2}>
        {suggestion.description}
      </Text>
      <Text style={[styles.macros, { color: colors.labelText }]}>
        {`EST. ${suggestion.calories} CAL · ${suggestion.protein}P · ${suggestion.carbs}C · ${suggestion.fat}F`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    padding: 12,
    marginTop: 10,
    gap: 4,
    minWidth: 230,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  tag: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
  },
  name: {
    fontSize: 16.5,
    lineHeight: 21,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  description: {
    fontSize: 12.5,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  macros: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.9,
    fontFamily: 'Inter_700Bold',
    marginTop: 4,
  },
});

// Module side effect: make the chat thread render "recipe" cards.
registerCoachCard('recipe', ({ payload }) => {
  const suggestion = parseRecipeCardPayload(payload);
  if (!suggestion) return null;
  return <RecipeSuggestionCard suggestion={suggestion} />;
});
