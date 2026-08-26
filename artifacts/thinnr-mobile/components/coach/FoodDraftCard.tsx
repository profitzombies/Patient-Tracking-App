/**
 * Food card rendered under a coach reply at the end of the label-to-food
 * flow.
 *
 * Registered for card kind "food" (module side effect — coach-chat.tsx
 * imports this file). Unlike the recipe card this one acts in place: the
 * payload is the server's label transcription plus the patient's confirmed
 * Title Case name, and the two actions run the real flows — Add saves the
 * custom food through the same path as the create-food screen ("My Foods",
 * editable, undoable) and logs one serving to the chosen diary slot; Rename
 * hands the next typed message to the chat context's label flow. Once added
 * the card freezes into a confirmation so a double tap cannot save twice.
 * Heritage styling: soft-radius inset card on the paper bubble, serif name,
 * Inter uppercase micro-labels.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { registerCoachCard } from '@/components/coach/CoachCardSlot';
import { useCoachChat } from '@/context/CoachChatContext';
import { usePatient } from '@/context/PatientContext';
import { MEAL_LABELS, MEAL_SLOTS, TODAY_KEY, type MealSlot } from '@/data/patient-data';
import { useColors } from '@/hooks/useColors';
import {
  buildCustomFoodFromLabel,
  buildLabelDiaryEntry,
  parseLabelFoodCardPayload,
  type LabelFoodCardPayload,
} from '@/lib/label-food';

/** "4g fiber · 12g sugar · 160mg sodium" for whichever extras were legible. */
function extrasLine(payload: LabelFoodCardPayload): string | null {
  const parts: string[] = [];
  if (payload.fiber !== undefined) parts.push(`${payload.fiber}g fiber`);
  if (payload.sugar !== undefined) parts.push(`${payload.sugar}g sugar`);
  if (payload.sodium !== undefined) parts.push(`${payload.sodium}mg sodium`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function FoodDraftCard({
  payload,
  messageId,
}: {
  payload: LabelFoodCardPayload;
  messageId: string;
}) {
  const colors = useColors();
  const patient = usePatient();
  const { labelFlow, beginLabelRename, markLabelFoodAdded } = useCoachChat();
  const [slot, setSlot] = useState<MealSlot>(payload.suggestedSlot);
  const [saving, setSaving] = useState(false);

  const renaming = labelFlow?.phase === 'renaming' && labelFlow.cardMessageId === messageId;
  const extras = extrasLine(payload);
  const servingLine =
    payload.servingsPerContainer !== null
      ? `${payload.servingSize} · ${payload.servingsPerContainer} per container`
      : payload.servingSize;

  const add = async () => {
    if (saving || payload.added) return;
    setSaving(true);
    try {
      // The same two steps Add Food runs: create the reusable custom food,
      // then log one serving of it to the chosen slot for today.
      const food = await patient.addCustomFood(buildCustomFoodFromLabel(payload));
      await patient.addEntry(buildLabelDiaryEntry(food, slot, TODAY_KEY));
      markLabelFoodAdded(messageId, slot);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View
      testID={`coach-food-card-${payload.id}`}
      style={[
        styles.card,
        {
          borderColor: colors.border,
          backgroundColor: colors.background,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      <Text style={[styles.tag, { color: colors.cobalt }]}>FOOD FROM YOUR LABEL</Text>
      <Text style={[styles.name, { color: colors.navy }]} numberOfLines={2}>
        {payload.name}
      </Text>
      <Text style={[styles.serving, { color: colors.bodyText }]} numberOfLines={2}>
        {servingLine}
      </Text>
      <Text style={[styles.macros, { color: colors.labelText }]}>
        {`${payload.calories} CAL · ${payload.protein}P · ${payload.carbs}C · ${payload.fat}F`}
      </Text>
      {extras ? (
        <Text style={[styles.extras, { color: colors.subtleText }]}>{extras}</Text>
      ) : null}
      {payload.flagged ? (
        <Text style={[styles.flagNote, { color: colors.orangeText }]}>
          The printed calories and macros disagree on this label. Worth a double check on the
          package.
        </Text>
      ) : null}

      {payload.added ? (
        <View style={styles.addedBlock}>
          <Text style={[styles.addedLine, { color: colors.cobalt }]}>
            {`Added to ${MEAL_LABELS[payload.addedSlot ?? slot]} · saved to My Foods`}
          </Text>
          <Text style={[styles.addedHint, { color: colors.subtleText }]}>
            Find it in Add Food anytime, and edit it like any of your foods.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.slotRow}>
            {MEAL_SLOTS.map(s => {
              const selected = s === slot;
              return (
                <Pressable
                  key={s}
                  testID={`food-card-slot-${s}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Log under ${MEAL_LABELS[s]}`}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSlot(s);
                  }}
                  style={[
                    styles.slotChip,
                    {
                      borderColor: selected ? colors.cobalt : colors.border,
                      backgroundColor: selected ? colors.cobalt : 'transparent',
                      borderRadius: colors.radiusSm,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.slotChipText,
                      { color: selected ? colors.primaryForeground : colors.bodyText },
                    ]}
                  >
                    {MEAL_LABELS[s]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.buttonRow}>
            <Pressable
              testID={`food-card-add-${payload.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Add ${payload.name} to ${MEAL_LABELS[slot]}`}
              disabled={saving}
              onPress={add}
              style={({ pressed }) => [
                styles.addButton,
                {
                  backgroundColor: colors.cobalt,
                  borderRadius: colors.radiusSm,
                  opacity: pressed || saving ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.addButtonText, { color: colors.primaryForeground }]}>
                {`Add to ${MEAL_LABELS[slot]}`}
              </Text>
            </Pressable>
            <Pressable
              testID={`food-card-rename-${payload.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Fix the name of ${payload.name}`}
              onPress={() => {
                Haptics.selectionAsync();
                beginLabelRename(messageId);
              }}
              style={({ pressed }) => [
                styles.renameButton,
                {
                  borderColor: colors.border,
                  borderRadius: colors.radiusSm,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text style={[styles.renameButtonText, { color: colors.bodyText }]}>Rename</Text>
            </Pressable>
          </View>
          {renaming ? (
            <Text style={[styles.renameHint, { color: colors.subtleText }]}>
              Type the new name in the message box and send it.
            </Text>
          ) : null}
        </>
      )}
    </View>
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
  tag: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  name: {
    fontSize: 16.5,
    lineHeight: 21,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  serving: {
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
  extras: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
  },
  flagNote: {
    fontSize: 11.5,
    lineHeight: 15.5,
    fontFamily: 'Inter_500Medium',
    marginTop: 4,
  },
  slotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  slotChip: {
    borderWidth: 1,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  slotChipText: {
    fontSize: 11.5,
    fontFamily: 'Inter_500Medium',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  addButton: {
    flexGrow: 1,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  addButtonText: {
    fontSize: 12.5,
    fontFamily: 'Inter_600SemiBold',
  },
  renameButton: {
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  renameButtonText: {
    fontSize: 12.5,
    fontFamily: 'Inter_500Medium',
  },
  renameHint: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
    marginTop: 6,
  },
  addedBlock: {
    marginTop: 8,
    gap: 2,
  },
  addedLine: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  addedHint: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
  },
});

// Module side effect: make the chat thread render "food" cards. A malformed
// payload renders nothing (defensive parse), so older payload shapes and
// unknown fields degrade gracefully.
registerCoachCard('food', ({ payload, messageId }) => {
  const parsed = parseLabelFoodCardPayload(payload);
  if (!parsed) return null;
  return <FoodDraftCard payload={parsed} messageId={messageId} />;
});
