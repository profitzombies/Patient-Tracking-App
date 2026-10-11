/**
 * One editable preference list (allergies, sensitivities, restrictions or
 * dislikes): catalog options as toggles, the patient's own free-text items
 * tagged "Custom", and — for allergies — a mild / severe switch per item.
 * Shared by the onboarding list steps (local answers) and the Food
 * preferences page (store-backed, offline-queued). RN primitives only.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { customPreferenceLabel } from '@/data/onboarding-data';
import { OptionChip } from './DietChoiceFields';

export type PreferenceSeverity = 'mild' | 'severe';

export interface EditorItem {
  id: string;
  key: string | null;
  label: string;
  severity?: PreferenceSeverity | null;
}

interface PreferenceListEditorProps {
  options: ReadonlyArray<{ key: string; label: string }>;
  items: EditorItem[];
  onAdd: (item: { key: string | null; label: string }) => void;
  onRemove: (item: EditorItem) => void;
  /** When set, each item shows a mild / severe toggle (allergies). */
  onSeverity?: (item: EditorItem, severity: PreferenceSeverity) => void;
  customPlaceholder?: string;
  /** Hides the catalog options (dislikes are free text only). */
  hideOptions?: boolean;
  testIDPrefix: string;
}

export function PreferenceListEditor({
  options,
  items,
  onAdd,
  onRemove,
  onSeverity,
  customPlaceholder = 'Add your own…',
  hideOptions = false,
  testIDPrefix,
}: PreferenceListEditorProps) {
  const colors = useColors();
  const [draft, setDraft] = useState('');
  const selectedKeys = new Set(items.map(i => i.key).filter((k): k is string => !!k));

  const submitDraft = () => {
    const label = customPreferenceLabel(draft);
    if (!label) return;
    const match = options.find(o => o.label.toLowerCase() === label.toLowerCase());
    const duplicate = items.some(i => (match ? i.key === match.key : !i.key && i.label.toLowerCase() === label.toLowerCase()));
    if (!duplicate) onAdd(match ? { key: match.key, label: match.label } : { key: null, label });
    setDraft('');
  };

  return (
    <View style={styles.block}>
      {!hideOptions ? (
        <View style={styles.row}>
          {options.map(opt => {
            const selected = selectedKeys.has(opt.key);
            return (
              <OptionChip
                key={opt.key}
                role="checkbox"
                label={opt.label}
                selected={selected}
                testID={`${testIDPrefix}-opt-${opt.key}`}
                onPress={() => {
                  const existing = items.find(i => i.key === opt.key);
                  if (existing) onRemove(existing);
                  else onAdd({ key: opt.key, label: opt.label });
                }}
              />
            );
          })}
        </View>
      ) : null}

      <View style={[styles.inputRow, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}>
        <TextInput
          testID={`${testIDPrefix}-custom-input`}
          value={draft}
          onChangeText={setDraft}
          placeholder={customPlaceholder}
          placeholderTextColor={colors.subtleText}
          returnKeyType="done"
          onSubmitEditing={submitDraft}
          style={[styles.input, { color: colors.navy }]}
          accessibilityLabel={customPlaceholder}
        />
        <Pressable
          testID={`${testIDPrefix}-custom-add`}
          accessibilityRole="button"
          accessibilityLabel="Add"
          onPress={submitDraft}
          style={({ pressed }) => [styles.addBtn, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }, pressed && { opacity: 0.85 }]}
        >
          <Text style={[styles.addText, { color: colors.primaryForeground }]}>Add</Text>
        </Pressable>
      </View>

      {items.length > 0 ? (
        <View style={styles.items}>
          {items.map(item => (
            <View
              key={item.id}
              testID={`${testIDPrefix}-item-${item.id}`}
              style={[styles.itemRow, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.labelRow}>
                  <Text style={[styles.itemLabel, { color: colors.navy }]}>{item.label}</Text>
                  {!item.key ? (
                    <Text testID={`${testIDPrefix}-item-${item.id}-custom`} style={[styles.customTag, { color: colors.labelText, borderColor: colors.border }]}>
                      CUSTOM
                    </Text>
                  ) : null}
                </View>
                {onSeverity ? (
                  <View style={styles.row}>
                    <OptionChip
                      label="Mild"
                      selected={(item.severity ?? 'mild') === 'mild'}
                      testID={`${testIDPrefix}-item-${item.id}-mild`}
                      onPress={() => onSeverity(item, 'mild')}
                    />
                    <OptionChip
                      label="Severe"
                      selected={item.severity === 'severe'}
                      testID={`${testIDPrefix}-item-${item.id}-severe`}
                      onPress={() => onSeverity(item, 'severe')}
                    />
                  </View>
                ) : null}
              </View>
              <Pressable
                testID={`${testIDPrefix}-item-${item.id}-remove`}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.label}`}
                hitSlop={8}
                onPress={() => onRemove(item)}
              >
                <Text style={[styles.remove, { color: colors.riskText }]}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingLeft: 12, paddingRight: 6, paddingVertical: 6, gap: 8 },
  input: { flex: 1, fontFamily: fonts.sans, fontSize: 14, paddingVertical: 6 },
  addBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  addText: { fontFamily: fonts.sansSemiBold, fontSize: 13 },
  items: { gap: 8 },
  itemRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, padding: 12, gap: 10 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemLabel: { fontFamily: fonts.sansMedium, fontSize: 14 },
  customTag: { fontFamily: fonts.sansMedium, fontSize: 9, letterSpacing: 0.6, borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  remove: { fontFamily: fonts.sansMedium, fontSize: 13 },
});
