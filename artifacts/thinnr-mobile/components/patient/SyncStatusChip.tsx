/**
 * SyncStatusChip — the patient shell's offline-queue indicator.
 *
 * A small capsule floats just above the pill bar only when a real account
 * has something worth saying about its writes: the device is offline
 * (writes are queuing), a save has been pending for longer than the grace
 * period, or an item needs attention. A normal online save acks well
 * inside the grace period and shows nothing at all. Once a drain the
 * patient could see finishes, the chip flashes "Up to date" briefly and
 * then leaves, so it takes no permanent room from the content shelf. Demo
 * and unresolved accounts never render it (the queue is disabled for them).
 *
 * Tapping the chip opens the detail sheet: every queued write in order,
 * oldest first, with its plain-words summary, a pending/failed state, and
 * — for failed items — retry and discard actions. "Retry all" tries the
 * failed ones in one go.
 *
 * Accessibility follows the announced-error pattern: the chip is a button
 * whose label carries the full state, and status changes announce through
 * a polite live region so a screen reader hears "Offline, 3 changes
 * waiting" without focus leaving the diary.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppModal } from '@/components/ui/AppModal';
import { useColors } from '@/hooks/useColors';
import { usePatientSync, type PatientSyncValue } from '@/context/PatientContext';
import { PATIENT_BAR_SIDE, PATIENT_SYNC_CHIP_HEIGHT, patientSyncChipBottom } from '@/constants/layout';
import type { QueuedWrite } from '@/lib/patient-write-queue';

const CHIP_SHADOW = '0 6px 16px rgba(23, 32, 46, 0.14)';

/**
 * Whether the chip is on screen for this sync state (shared with the
 * snackbar shelf). Offline and attention show at once; "syncing" waits for
 * the slow-sync grace period so a routine save never flashes the chip.
 */
export function syncChipVisible(sync: PatientSyncValue): boolean {
  if (!sync.enabled) return false;
  switch (sync.status) {
    case 'offline':
    case 'attention':
      return true;
    case 'syncing':
      return sync.slowSync;
    case 'idle':
      return sync.justSynced;
  }
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

/** Chip copy for each state — also the accessible name. */
export function syncChipLabel(sync: PatientSyncValue): string {
  const waiting = sync.pendingCount + sync.failedCount;
  switch (sync.status) {
    case 'offline':
      return waiting > 0 ? `Offline · ${plural(waiting, 'change')} waiting` : 'Offline';
    case 'attention':
      return `${plural(sync.failedCount, 'change')} need${sync.failedCount === 1 ? 's' : ''} attention`;
    case 'syncing':
      return `Syncing ${plural(sync.pendingCount, 'change')}`;
    case 'idle':
      return 'Up to date';
  }
}

function itemStateLabel(item: QueuedWrite): string {
  if (item.status === 'failed') return item.lastError ?? 'Couldn’t save';
  if (item.attempts > 0) return `Retrying · ${item.lastError ?? 'waiting for a connection'}`;
  return 'Waiting to sync';
}

export function SyncStatusChip() {
  const sync = usePatientSync();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  if (!syncChipVisible(sync)) return null;

  const label = syncChipLabel(sync);
  const tone =
    sync.status === 'attention'
      ? { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText }
      : sync.status === 'offline'
        ? { bg: colors.muted, border: colors.border, text: colors.bodyText }
        : { bg: colors.activeBg, border: colors.activeBorder, text: colors.cobalt };
  const icon: keyof typeof Feather.glyphMap =
    sync.status === 'attention'
      ? 'alert-circle'
      : sync.status === 'offline'
        ? 'wifi-off'
        : sync.status === 'syncing'
          ? 'refresh-cw'
          : 'check-circle';

  return (
    <>
      <View
        // Announce state changes without stealing focus from the diary.
        accessibilityLiveRegion="polite"
        aria-live="polite"
        style={[
          styles.chipWrap,
          { bottom: patientSyncChipBottom(insets.bottom), left: PATIENT_BAR_SIDE },
        ]}
      >
        <Pressable
          testID="patient-sync-chip"
          accessibilityRole="button"
          role="button"
          accessibilityLabel={`${label}. Show sync details`}
          onPress={() => setOpen(true)}
          style={({ pressed }) => [
            styles.chip,
            {
              height: PATIENT_SYNC_CHIP_HEIGHT,
              borderRadius: PATIENT_SYNC_CHIP_HEIGHT / 2,
              backgroundColor: tone.bg,
              borderColor: tone.border,
              boxShadow: CHIP_SHADOW,
            },
            pressed && { opacity: 0.8 },
          ]}
        >
          {sync.status === 'syncing' ? (
            <ActivityIndicator size="small" color={tone.text} style={styles.chipSpinner} />
          ) : (
            <Feather name={icon} size={13} color={tone.text} />
          )}
          <Text testID="patient-sync-chip-label" style={[styles.chipText, { color: tone.text }]} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      </View>
      <SyncDetailSheet sync={sync} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function SyncDetailSheet({
  sync,
  visible,
  onClose,
}: {
  sync: PatientSyncValue;
  visible: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const [busyId, setBusyId] = useState<string | null>(null);
  const headline =
    sync.status === 'offline'
      ? 'You’re offline. Everything you log is saved on this phone and will sync when you’re back online.'
      : sync.status === 'attention'
        ? 'Some changes couldn’t be saved. Retry them, or discard to drop them.'
        : sync.status === 'syncing'
          ? 'Syncing your changes now.'
          : 'Everything is saved.';

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          testID="patient-sync-sheet"
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetLabel, { color: colors.labelText }]}>SYNC</Text>
            <Pressable
              testID="patient-sync-sheet-close"
              accessibilityRole="button"
              accessibilityLabel="Close sync details"
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
          <Text testID="patient-sync-sheet-headline" style={[styles.headline, { color: colors.cardForeground }]}>
            {headline}
          </Text>
          {sync.items.length === 0 ? (
            <Text style={[styles.empty, { color: colors.subtleText }]}>Nothing waiting to sync.</Text>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {sync.items.map(item => {
                const failed = item.status === 'failed';
                return (
                  <View
                    key={item.id}
                    testID={`patient-sync-item-${item.id}`}
                    style={[
                      styles.item,
                      {
                        borderColor: failed ? colors.warnBorder : colors.border,
                        backgroundColor: failed ? colors.warnBg : colors.paperCardAlt,
                        borderRadius: colors.radiusSm,
                      },
                    ]}
                  >
                    <View style={styles.itemHead}>
                      <Feather
                        name={failed ? 'alert-circle' : 'clock'}
                        size={13}
                        color={failed ? colors.warnText : colors.mutedForeground}
                        style={{ marginTop: 2 }}
                      />
                      <View style={styles.itemText}>
                        <Text style={[styles.itemSummary, { color: colors.cardForeground }]}>{item.summary}</Text>
                        <Text
                          testID={`patient-sync-item-state-${item.id}`}
                          style={[styles.itemState, { color: failed ? colors.warnText : colors.subtleText }]}
                        >
                          {itemStateLabel(item)}
                        </Text>
                      </View>
                    </View>
                    {failed ? (
                      <View style={styles.itemActions}>
                        <Pressable
                          testID={`patient-sync-retry-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Retry: ${item.summary}`}
                          onPress={() => sync.retry(item.id)}
                          style={({ pressed }) => [
                            styles.actionBtn,
                            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                            pressed && { opacity: 0.85 },
                          ]}
                        >
                          <Text style={[styles.actionText, { color: colors.primaryForeground }]}>Retry</Text>
                        </Pressable>
                        <Pressable
                          testID={`patient-sync-discard-${item.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Discard: ${item.summary}`}
                          disabled={busyId === item.id}
                          onPress={() => {
                            setBusyId(item.id);
                            void sync.discard(item.id).finally(() => setBusyId(current => (current === item.id ? null : current)));
                          }}
                          style={({ pressed }) => [
                            styles.actionBtn,
                            styles.ghostBtn,
                            { borderColor: colors.border, borderRadius: colors.radiusSm },
                            pressed && { opacity: 0.7 },
                          ]}
                        >
                          <Text style={[styles.actionText, { color: colors.destructive }]}>Discard</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          )}
          {sync.failedCount > 1 ? (
            <Pressable
              testID="patient-sync-retry-all"
              accessibilityRole="button"
              accessibilityLabel="Retry all failed changes"
              onPress={sync.retryAll}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Feather name="refresh-cw" size={14} color={colors.primaryForeground} />
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>Retry all</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  chipWrap: {
    position: 'absolute',
    // Never wider than the pill bar's own left half so it stays clear of
    // the launcher circle and any snackbar action.
    maxWidth: '62%',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    borderWidth: 1,
  },
  chipSpinner: {
    transform: [{ scale: Platform.OS === 'web' ? 0.7 : 0.8 }],
  },
  chipText: {
    fontSize: 11.5,
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(23, 32, 46, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '80%',
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  headline: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  empty: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: 8,
  },
  item: {
    borderWidth: 1,
    padding: 10,
    gap: 8,
  },
  itemHead: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
  },
  itemText: {
    flex: 1,
    gap: 2,
  },
  itemSummary: {
    fontSize: 12.5,
    fontFamily: 'Inter_600SemiBold',
  },
  itemState: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
  },
  itemActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    minHeight: 34,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostBtn: {
    borderWidth: 1,
  },
  actionText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  primaryBtn: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
});
