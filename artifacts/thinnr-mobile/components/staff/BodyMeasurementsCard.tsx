/**
 * Staff "Body measurements" card and its Log a Visit sheet.
 *
 * The card lays every visit out side by side (one column per visit, newest
 * first; one row per body area, inches plus the change since the patient's
 * first recording of that area) inside a horizontal scroller so a long
 * history never squeezes the numbers. The sheet mirrors the Log Weight /
 * Add Note form sheets: AppModal + header actions, keyboard-aware scroll,
 * one decimal field per area, a date picker, an optional note, and inline
 * validation from the shared body-measurements rules.
 *
 * Kept free of native-only imports beyond the app's own primitives so the
 * body-measurements suite can render it under react-test-renderer.
 */
import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { AppModal } from '@/components/ui/AppModal';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { LocalDatePicker } from '@/components/ui/LocalDatePicker';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import theme, { fonts } from '@/constants/colors';
import {
  BODY_AREAS,
  INCHES_HINT,
  buildMeasurementTable,
  formatInches,
  formatInchesChange,
  totalInchesChange,
  validateVisitForm,
  type BodyAreaKey,
  type MeasurementVisit,
  type VisitFormInput,
  type VisitFormResult,
} from '@/data/body-measurements';
import { useColors } from '@/hooks/useColors';

export type VisitDraft = NonNullable<VisitFormResult['value']>;

const LABEL_COLUMN_WIDTH = 96;
const VISIT_COLUMN_WIDTH = 112;

export const formatVisitDay = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function localTodayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function summarizeVisits(visits: MeasurementVisit[]): string {
  if (visits.length === 0) return 'Inches by body area, visit over visit';
  const total = totalInchesChange(buildMeasurementTable(visits));
  const count = `${visits.length} visit${visits.length === 1 ? '' : 's'}`;
  if (total === null) return `${count} · change appears from the second visit`;
  if (total < 0) return `${count} · ${Math.abs(total).toFixed(1)} in lost since the first visit`;
  if (total > 0) return `${count} · ${total.toFixed(1)} in gained since the first visit`;
  return `${count} · no net change since the first visit`;
}

// ─── Card ────────────────────────────────────────────────────────────────────

interface BodyMeasurementsCardProps {
  visits: MeasurementVisit[];
  onLogPress: () => void;
  onRemove: (visit: MeasurementVisit) => void | Promise<void>;
}

export function BodyMeasurementsCard({ visits, onLogPress, onRemove }: BodyMeasurementsCardProps) {
  const colors = useColors();
  const table = useMemo(() => buildMeasurementTable(visits), [visits]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const baselineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of table.rows) {
      const baseline = [...row.cells].reverse().find(cell => cell.value !== null);
      if (baseline) ids.add(`${row.key}:${baseline.visitId}`);
    }
    return ids;
  }, [table]);

  const confirmRemove = async (visit: MeasurementVisit) => {
    setRemovingId(visit.id);
    try {
      await onRemove(visit);
    } finally {
      setRemovingId(null);
      setConfirmingId(null);
    }
  };

  return (
    <LedgerCard>
      <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: colors.labelText }]}>BODY MEASUREMENTS</Text>
          <Text style={[styles.cardSubtitle, { color: colors.subtleText }]} testID="measurements-summary">{summarizeVisits(visits)}</Text>
        </View>
        <Pressable
          testID="log-visit-btn"
          accessibilityRole="button"
          accessibilityLabel="Log a Visit"
          onPress={onLogPress}
          style={({ pressed }) => [styles.actionLink, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="plus-circle" size={13} color={colors.cobalt} />
          <Text style={[styles.actionLinkText, { color: colors.cobalt }]}>Log a Visit</Text>
        </Pressable>
      </View>

      {visits.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={[styles.emptyText, { color: colors.subtleText }]} testID="measurements-empty">
            No measurement visits yet. Log a visit to start tracking inches lost alongside pounds lost.
          </Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.tableScroll}
          testID="measurements-table"
          accessibilityLabel="Body measurement visits, newest first, in inches"
        >
          <View>
            {/* Header: one column per visit */}
            <View style={[styles.tableRow, styles.tableHeadRow, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.divider }]}>
              <View style={[styles.labelCell, { width: LABEL_COLUMN_WIDTH }]}>
                <Text style={[styles.headLabel, { color: colors.labelText }]}>AREA</Text>
              </View>
              {table.visits.map(visit => {
                const confirming = confirmingId === visit.id;
                return (
                  <View key={visit.id} style={[styles.visitHeadCell, { width: VISIT_COLUMN_WIDTH }]} testID={`visit-column-${visit.id}`}>
                    <Text style={[styles.visitDate, { color: colors.navy }]}>{formatVisitDay(visit.dateKey)}</Text>
                    {visit.recordedByName ? (
                      <Text style={[styles.visitMeta, { color: colors.subtleText }]} numberOfLines={1}>{visit.recordedByName}</Text>
                    ) : null}
                    {visit.note ? (
                      <Text style={[styles.visitNote, { color: colors.subtleText }]} numberOfLines={2}>{visit.note}</Text>
                    ) : null}
                    {confirming ? (
                      <View style={styles.confirmRow}>
                        <Pressable
                          testID={`confirm-remove-visit-${visit.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Confirm removing the ${formatVisitDay(visit.dateKey)} visit`}
                          disabled={removingId === visit.id}
                          onPress={() => void confirmRemove(visit)}
                          hitSlop={6}
                        >
                          <Text style={[styles.removeText, { color: colors.riskText }]}>{removingId === visit.id ? 'Removing…' : 'Remove'}</Text>
                        </Pressable>
                        <Pressable
                          testID={`cancel-remove-visit-${visit.id}`}
                          accessibilityRole="button"
                          accessibilityLabel="Keep this visit"
                          onPress={() => setConfirmingId(null)}
                          hitSlop={6}
                        >
                          <Text style={[styles.removeText, { color: colors.bodyText }]}>Keep</Text>
                        </Pressable>
                      </View>
                    ) : (
                      <Pressable
                        testID={`remove-visit-${visit.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove the ${formatVisitDay(visit.dateKey)} visit`}
                        onPress={() => setConfirmingId(visit.id)}
                        hitSlop={6}
                        style={styles.removeLink}
                      >
                        <Feather name="trash-2" size={11} color={colors.riskText} />
                        <Text style={[styles.removeText, { color: colors.riskText }]}>Remove</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>

            {/* Body: one row per area */}
            {table.rows.map(row => (
              <View key={row.key} style={[styles.tableRow, { borderBottomColor: colors.divider }]} testID={`measurement-row-${row.key}`}>
                <View style={[styles.labelCell, { width: LABEL_COLUMN_WIDTH }]}>
                  <Text style={[styles.rowLabel, { color: colors.foreground }]}>{row.label}</Text>
                </View>
                {row.cells.map(cell => {
                  const changeColor = cell.change === null
                    ? colors.subtleText
                    : cell.change < 0
                      ? colors.cobalt
                      : cell.change > 0
                        ? colors.warnText
                        : colors.subtleText;
                  const changeText = cell.change === null
                    ? (baselineIds.has(`${row.key}:${cell.visitId}`) ? 'First recorded' : '')
                    : formatInchesChange(cell.change);
                  return (
                    <View key={cell.visitId} style={[styles.valueCell, { width: VISIT_COLUMN_WIDTH }]} testID={`measurement-cell-${row.key}-${cell.visitId}`}>
                      {cell.value === null ? (
                        <Text style={[styles.dash, { color: colors.subtleText }]} accessibilityLabel="Not measured">—</Text>
                      ) : (
                        <>
                          <Text style={[styles.value, { color: colors.navy }]}>{formatInches(cell.value)}</Text>
                          <Text style={[styles.change, { color: changeColor }]}>{changeText}</Text>
                        </>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </LedgerCard>
  );
}

// ─── Sheet ───────────────────────────────────────────────────────────────────

type FormErrors = VisitFormResult['errors'] & { form?: string };

interface LogVisitSheetProps {
  visible: boolean;
  todayKey: string;
  topInset: number;
  patientName: string;
  onClose: () => void;
  /** Resolves once the visit is stored; the sheet then shows "Saved" and closes itself. */
  onSave: (draft: VisitDraft) => Promise<void>;
}

export function LogVisitSheet({ visible, todayKey, topInset, patientName, onClose, onSave }: LogVisitSheetProps) {
  const colors = useColors();
  const [form, setForm] = useState<VisitFormInput>({ dateKey: todayKey, note: '', inches: {} });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [openedFor, setOpenedFor] = useState<boolean>(visible);

  // Reset the draft each time the sheet opens (render-time derived state).
  if (visible !== openedFor) {
    setOpenedFor(visible);
    if (visible) {
      setForm({ dateKey: todayKey, note: '', inches: {} });
      setErrors({});
      setSaved(false);
      setPending(false);
    }
  }

  const setInches = (key: BodyAreaKey, value: string) => {
    setForm(current => ({ ...current, inches: { ...current.inches, [key]: value } }));
    setErrors(current => ({ ...current, [key]: undefined, measurements: undefined, form: undefined }));
  };

  const save = async () => {
    if (pending || saved) return;
    const result = validateVisitForm(form, todayKey);
    if (!result.value) {
      setErrors(result.errors);
      return;
    }
    setPending(true);
    try {
      await onSave(result.value);
      setSaved(true);
      setTimeout(onClose, 800);
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : 'The visit was not saved. Try again.' });
    } finally {
      setPending(false);
    }
  };

  const animationType = Platform.OS === 'web' ? 'none' as const : 'slide' as const;
  const measurementsError = errors.measurements ?? errors.form;

  return (
    <AppModal visible={visible} animationType={animationType} presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.modalHeader, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: topInset + 16 }]}>
          <Pressable
            testID="visit-cancel-btn"
            accessibilityRole="button"
            hitSlop={8}
            onPressIn={onClose}
            onPress={onClose}
            style={styles.modalHeaderAction}
          >
            <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.modalTitle, { color: colors.navy }]}>Log a Visit</Text>
          <Pressable
            testID="visit-save-btn"
            accessibilityRole="button"
            onPress={() => void save()}
            disabled={saved || pending}
            style={[styles.modalHeaderAction, styles.modalHeaderActionEnd]}
          >
            <Text style={[styles.modalSave, { color: saved || pending ? colors.subtleText : colors.cobalt }]}>
              {saved ? 'Saved' : pending ? 'Saving…' : 'Save'}
            </Text>
          </Pressable>
        </View>
        <KeyboardAwareScrollViewCompat style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 48 }} bottomOffset={24}>
          <Text style={[styles.sheetIntro, { color: colors.bodyText }]}>
            Record {patientName}'s measurements in inches. Leave any area you did not measure blank.
          </Text>

          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>VISIT DATE</Text>
          <LocalDatePicker
            testID="visit-date"
            value={form.dateKey}
            maxDate={todayKey}
            onChange={dateKey => {
              setForm(current => ({ ...current, dateKey }));
              setErrors(current => ({ ...current, dateKey: undefined }));
            }}
          />
          {errors.dateKey ? <Text style={[styles.fieldError, { color: colors.riskText }]} testID="visit-error-dateKey">{errors.dateKey}</Text> : null}

          <Text style={[styles.fieldLabel, { color: colors.labelText, marginTop: 18 }]}>MEASUREMENTS (INCHES)</Text>
          <Text style={[styles.fieldHint, { color: colors.subtleText }]}>{INCHES_HINT}</Text>
          <View style={styles.areaGrid}>
            {BODY_AREAS.map(area => {
              const error = errors[area.key];
              return (
                <View key={area.key} style={styles.areaField}>
                  <Text style={[styles.areaLabel, { color: colors.foreground }]}>{area.label}</Text>
                  <TextInput
                    testID={`visit-input-${area.key}`}
                    accessibilityLabel={`${area.label} in inches`}
                    value={form.inches[area.key] ?? ''}
                    onChangeText={text => setInches(area.key, text)}
                    keyboardType="decimal-pad"
                    inputMode="decimal"
                    placeholder="—"
                    placeholderTextColor={colors.subtleText}
                    style={[
                      styles.fieldInput,
                      { borderColor: error ? colors.riskText : colors.border, color: colors.foreground, backgroundColor: colors.card },
                    ]}
                  />
                  {error ? <Text style={[styles.fieldError, { color: colors.riskText }]} testID={`visit-error-${area.key}`}>{error}</Text> : null}
                </View>
              );
            })}
          </View>
          {measurementsError ? (
            <Text style={[styles.fieldError, { color: colors.riskText }]} testID="visit-error-measurements" accessibilityRole="alert">{measurementsError}</Text>
          ) : null}

          <Text style={[styles.fieldLabel, { color: colors.labelText, marginTop: 18 }]}>NOTE (OPTIONAL)</Text>
          <TextInput
            testID="visit-note"
            value={form.note}
            onChangeText={text => {
              setForm(current => ({ ...current, note: text }));
              setErrors(current => ({ ...current, note: undefined }));
            }}
            multiline
            numberOfLines={3}
            maxLength={500}
            placeholder="e.g. Measured over light clothing"
            placeholderTextColor={colors.subtleText}
            style={[styles.textArea, { borderColor: errors.note ? colors.riskText : colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          />
          {errors.note ? <Text style={[styles.fieldError, { color: colors.riskText }]} testID="visit-error-note">{errors.note}</Text> : null}
          {saved ? <Text style={[styles.fieldSuccess, { color: colors.cobalt }]} testID="visit-saved">Visit saved to this device's record.</Text> : null}
        </KeyboardAwareScrollViewCompat>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  cardTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 8,
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  cardSubtitle: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
  },
  actionLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 32,
  },
  actionLinkText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  emptyWrap: {
    padding: 16,
  },
  emptyText: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  tableScroll: {
    flexGrow: 1,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tableHeadRow: {
    borderBottomWidth: 1,
  },
  labelCell: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  headLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
  visitHeadCell: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 2,
  },
  visitDate: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  visitMeta: {
    fontSize: 9,
    fontFamily: 'Inter_500Medium',
  },
  visitNote: {
    fontSize: 9,
    fontStyle: 'italic',
    fontFamily: 'Inter_400Regular',
    lineHeight: 12,
  },
  removeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    minHeight: 24,
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
    minHeight: 24,
  },
  removeText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  rowLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  valueCell: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.2,
  },
  change: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 1,
  },
  dash: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  // Sheet
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  modalHeaderAction: {
    minWidth: 60,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  modalHeaderActionEnd: {
    alignItems: 'flex-end',
  },
  modalCancel: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: fonts.serifBold,
  },
  modalSave: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  sheetIntro: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    marginBottom: 18,
  },
  fieldLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 8,
  },
  fieldHint: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
    marginBottom: 10,
  },
  areaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 12,
  },
  areaField: {
    width: '47%',
    flexGrow: 1,
  },
  areaLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 6,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  textArea: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
    fontFamily: 'Inter_400Regular',
  },
  fieldError: {
    fontSize: 11,
    marginTop: 6,
    fontFamily: 'Inter_400Regular',
  },
  fieldSuccess: {
    fontSize: 11,
    marginTop: 12,
    fontFamily: 'Inter_600SemiBold',
  },
});
