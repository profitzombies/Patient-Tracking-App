/**
 * Patient onboarding preference steps: health app, notifications, medication
 * reminders (morning / afternoon / evening) and completion. The diet and
 * food-preference steps live in StepsDiet.tsx.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { useOnboarding, useOnboardingFlow } from '@/context/OnboardingContext';
import { useDeviceFeatures } from '@/context/DeviceFeaturesContext';
import {
  HEALTH_APP_BENEFITS,
  INJECTION_DAY_OPTIONS,
  injectionTimeOptions,
  MONTH_LABELS,
  NOTIFICATION_ITEMS,
  programTitle,
  REMINDER_META,
  reminderOptions,
  startDateLabelFor,
  weightUnitFor,
  type ReminderSlot,
} from '@/data/onboarding-data';
import { DIET_BY_SLUG } from '@/lib/diet-fit';
import { OnboardingFrame } from './OnboardingFrame';
import {
  ChipGrid,
  GhostButton,
  InfoCard,
  NoteText,
  PrimaryButton,
} from './OnboardingFields';

// ─── Shared benefit list ─────────────────────────────────────────────────────

function BenefitList({ items, icons }: { items: string[]; icons: React.ComponentProps<typeof Feather>['name'][] }) {
  const colors = useColors();
  return (
    <LedgerCard style={styles.benefitCard}>
      {items.map((item, i) => (
        <View key={item} style={styles.benefitRow}>
          <View style={[styles.benefitIcon, { backgroundColor: colors.accent }]}>
            <Feather name={icons[i % icons.length]} size={13} color={colors.cobalt} />
          </View>
          <Text style={[styles.benefitText, { color: colors.bodyText }]}>{item}</Text>
        </View>
      ))}
    </LedgerCard>
  );
}

// ─── Health app ──────────────────────────────────────────────────────────────

export function HealthAppStep() {
  const { patch } = useOnboarding();
  const flow = useOnboardingFlow('health-app');
  const device = useDeviceFeatures();

  const choose = (healthApp: 'connected' | 'skipped') => {
    patch({ healthApp });
    flow.goNext();
  };

  return (
    <OnboardingFrame
      stepKey="health-app"
      title="Connect your health app"
      coach="Almost there — want your steps and workouts to count automatically?"
      hideNext
    >
      <BenefitList items={HEALTH_APP_BENEFITS} icons={['activity', 'trending-down', 'zap', 'heart']} />
      <PrimaryButton
        testID="ob-health-connect"
        label={device.busy ? 'Requesting access…' : 'Connect and import last 30 days'}
        disabled={device.busy || device.health === 'web' || device.health === 'expo-go' || device.health === 'unsupported'}
        onPress={() => void device.connectAndImportHealth().then(ok => { if (ok) choose('connected'); })}
        style={styles.btnGap}
      />
      <GhostButton testID="ob-health-skip" label="Skip for now" onPress={() => choose('skipped')} />
      <View style={styles.noteGap}>
        <NoteText center text={device.message ?? (
          device.health === 'web' ? 'Apple Health and Health Connect are unavailable on web.' :
          device.health === 'expo-go' ? 'Health access requires a development build and is unavailable in Expo Go.' :
          'THINNR requests read-only access to weight and steps. No other health categories are imported.'
        )} />
      </View>
    </OnboardingFrame>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

export function NotificationsStep() {
  const { patch } = useOnboarding();
  const flow = useOnboardingFlow('notifications');
  const device = useDeviceFeatures();

  const choose = (notifications: 'enabled' | 'later') => {
    patch({ notifications });
    flow.goNext();
  };

  return (
    <OnboardingFrame
      stepKey="notifications"
      title="Stay on track with reminders"
      coach="Members who keep notifications on log twice as consistently."
      hideNext
    >
      <BenefitList items={NOTIFICATION_ITEMS} icons={['clock', 'edit-3', 'calendar', 'message-square']} />
      <PrimaryButton
        testID="ob-notif-enable"
        label="Enable notifications"
        disabled={device.busy || device.notification === 'web'}
        onPress={() => void device.enableNotifications().then(ok => { if (ok) choose('enabled'); })}
        style={styles.btnGap}
      />
      <GhostButton testID="ob-notif-later" label="Maybe later" onPress={() => choose('later')} />
      <View style={styles.noteGap}>
        <NoteText center text={device.message ?? (
          device.notification === 'web'
            ? 'Local medication reminders are unavailable on web.'
            : 'Your phone will ask for notification permission. You can change this anytime in settings.'
        )} />
      </View>
    </OnboardingFrame>
  );
}

// ─── Weekly injection day ────────────────────────────────────────────────────

export function InjectionDayStep() {
  const colors = useColors();
  const { answers, patch } = useOnboarding();
  return (
    <OnboardingFrame
      stepKey="injection-day"
      title="Your injection day"
      coach="Which day do you take your GLP-1 injection? We’ll remind you that morning."
      nextDisabled={answers.injectionDay === null}
      nextBlockedHint="Pick the day you take your injection."
    >
      <ChipGrid
        options={INJECTION_DAY_OPTIONS.map(d => ({ label: d.label, value: String(d.value) }))}
        value={answers.injectionDay === null ? '' : String(answers.injectionDay)}
        onChange={v => patch({ injectionDay: Number(v) })}
        testIDPrefix="ob-injection-day"
      />
      <Text style={[styles.scheduleLabel, styles.noteGap, { color: colors.labelText }]}>REMINDER TIME</Text>
      <ChipGrid
        options={injectionTimeOptions().map(t => ({ label: t, value: t }))}
        value={answers.injectionTime}
        onChange={v => patch({ injectionTime: v })}
        testIDPrefix="ob-injection-time"
      />
      <View style={styles.noteGap}>
        <InfoCard label="Same day each week" body="Most people pick the day they started. Your reminder names the medication and can be changed anytime from your account." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Medication reminders ────────────────────────────────────────────────────

const SLOT_COACH: Record<ReminderSlot, string> = {
  morning: 'When should we remind you about your morning dose?',
  afternoon: 'And your afternoon dose?',
  evening: 'Last one — your evening dose.',
};

function ScheduleSoFar({ slot }: { slot: ReminderSlot }) {
  const colors = useColors();
  const { answers } = useOnboarding();
  const rows: { label: string; value: string }[] = [];
  if (slot !== 'morning') rows.push({ label: 'MORNING', value: answers.reminderMorning });
  if (slot === 'evening') rows.push({ label: 'AFTERNOON', value: answers.reminderAfternoon });
  if (rows.length === 0) return null;
  return (
    <LedgerCard style={styles.scheduleCard}>
      <Text style={[styles.scheduleLabel, { color: colors.labelText }]}>SCHEDULE SO FAR</Text>
      {rows.map(row => (
        <View key={row.label} style={styles.scheduleRow}>
          <Text style={[styles.scheduleSlot, { color: colors.subtleText }]}>{row.label}</Text>
          <Text style={[styles.scheduleTime, { color: colors.navy }]}>{row.value}</Text>
        </View>
      ))}
    </LedgerCard>
  );
}

function ReminderStepBase({ slot }: { slot: ReminderSlot }) {
  const { answers, patch } = useOnboarding();
  const meta = REMINDER_META[slot];
  const stepKey = `reminder-${slot}` as const;
  const windowBody =
    slot === 'morning'
      ? `${meta.window}. Doses work best spaced about 7 hours apart.`
      : `${meta.window}.`;

  return (
    <OnboardingFrame
      stepKey={stepKey}
      title={`${meta.title} reminder`}
      coach={SLOT_COACH[slot]}
      nextLabel={slot === 'evening' ? 'Complete setup' : 'Next'}
    >
      <ChipGrid
        options={reminderOptions(slot).map(t => ({ label: t, value: t }))}
        value={answers[meta.field]}
        onChange={v => patch({ [meta.field]: v })}
        testIDPrefix="ob-time"
      />
      <View style={styles.noteGap}>
        <InfoCard label="Recommended window" body={windowBody} />
      </View>
      <ScheduleSoFar slot={slot} />
    </OnboardingFrame>
  );
}

export function ReminderMorningStep() {
  return <ReminderStepBase slot="morning" />;
}
export function ReminderAfternoonStep() {
  return <ReminderStepBase slot="afternoon" />;
}
export function ReminderEveningStep() {
  return <ReminderStepBase slot="evening" />;
}

// ─── Completion ──────────────────────────────────────────────────────────────

export function CompleteStep() {
  const colors = useColors();
  const { answers, endRun } = useOnboarding();
  const { setMode } = useAppMode();

  const unit = weightUnitFor(answers.heightUnit);
  const onMeds = answers.program === 'thinnr' || answers.program === 'glp1';
  const height =
    answers.heightUnit === 'imperial'
      ? `${answers.heightFt}′ ${answers.heightIn}″`
      : `${answers.heightCm} cm`;
  const gender = answers.gender ? answers.gender[0].toUpperCase() + answers.gender.slice(1) : '—';
  const birthday = answers.birthMonth
    ? `${MONTH_LABELS[answers.birthMonth - 1]} ${answers.birthDay}, ${answers.birthYear}`
    : '—';

  const rows: { label: string; value: string }[] = [
    { label: 'NAME', value: answers.name.trim() || '—' },
    { label: 'CONTACT', value: [answers.email.trim(), answers.phone.trim()].filter(Boolean).join(' · ') || '—' },
    { label: 'PROFILE', value: `${height} · ${answers.currentWeight} ${unit} · ${gender}` },
    { label: 'BIRTHDAY', value: birthday },
    { label: 'PROGRAM', value: programTitle(answers.program) },
  ];
  if (onMeds) {
    rows.push({
      label: 'START',
      value:
        answers.started === 'yes'
          ? 'Already started'
          : startDateLabelFor(answers.startOffsetDays, true),
    });
  }
  rows.push({ label: 'GOAL', value: `${answers.goalWeight} ${unit}` });
  if (answers.program === 'thinnr') {
    rows.push({
      label: 'REMINDERS',
      value: `${answers.reminderMorning} · ${answers.reminderAfternoon} · ${answers.reminderEvening}`,
    });
  } else if (answers.program === 'glp1') {
    const day = INJECTION_DAY_OPTIONS.find(d => d.value === answers.injectionDay)?.label ?? '—';
    rows.push({ label: 'INJECTION', value: `${day} · ${answers.injectionTime}` });
  }
  rows.push(
    {
      label: 'HEALTH APP',
      value: answers.healthApp === 'connected' ? 'Connected · weight and steps only' : 'Skipped',
    },
    {
      label: 'NOTIFICATIONS',
      value: answers.notifications === 'enabled' ? 'Enabled' : 'Maybe later',
    },
    {
      label: 'DIET',
      value: answers.dietSlug
        ? DIET_BY_SLUG.get(answers.dietSlug)?.name ?? answers.dietSlug
        : answers.program === 'thinnr'
          ? 'THINNR protocol (picker unlocks after)'
          : '—',
    },
    {
      label: 'ALLERGIES',
      value: answers.allergiesNone
        ? 'None'
        : answers.allergies.map(a => a.label).join(', ') || '—',
    },
  );
  const extras = [...answers.sensitivities, ...answers.restrictions, ...answers.dislikes];
  if (extras.length > 0) {
    rows.push({ label: 'ALSO AVOIDING', value: extras.map(e => e.label).join(', ') });
  }

  const finish = async () => {
    const saved = await endRun();
    if (!saved) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setMode('patient');
    router.replace('/today');
  };

  return (
    <OnboardingFrame
      stepKey="complete"
      title="You're all set"
      coach="That's everything. Welcome to THINNR — see you at your first check-in!"
      nextLabel="Enter THINNR"
      onNext={finish}
    >
      <View style={[styles.doneBadge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
        <Feather name="check" size={14} color={colors.activeGreen} />
        <Text style={[styles.doneBadgeText, { color: colors.activeGreen }]}>SETUP COMPLETE</Text>
      </View>
      <LedgerCard style={styles.summaryCard} testID="ob-summary">
        {rows.map((row, i) => (
          <View key={row.label}>
            {i > 0 ? <Divider /> : null}
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.labelText }]}>{row.label}</Text>
              <Text style={[styles.summaryValue, { color: colors.navy }]} numberOfLines={2}>
                {row.value}
              </Text>
            </View>
          </View>
        ))}
      </LedgerCard>
      <NoteText text="Your setup is saved to your patient account and will be here when you return." />
    </OnboardingFrame>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  benefitCard: {
    padding: 16,
    gap: 12,
    marginBottom: 18,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  benefitIcon: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  benefitText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  btnGap: {
    marginBottom: 10,
  },
  noteGap: {
    marginTop: 16,
  },
  scheduleCard: {
    padding: 14,
    marginTop: 12,
  },
  scheduleLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 8,
  },
  scheduleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  scheduleSlot: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
  scheduleTime: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginBottom: 14,
  },
  doneBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
  summaryCard: {
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
  },
  summaryLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
  },
  summaryValue: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'right',
  },
});
