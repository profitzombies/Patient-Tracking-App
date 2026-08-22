/**
 * Simulated onboarding — preference steps: health app, notifications,
 * medication reminders (morning / afternoon / evening), diets, completion.
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
import {
  DIET_NONE_KEY,
  DIET_OPTIONS,
  HEALTH_APP_BENEFITS,
  MONTH_LABELS,
  NOTIFICATION_ITEMS,
  programTitle,
  REMINDER_META,
  reminderOptions,
  startDateLabelFor,
  weightUnitFor,
  type ReminderSlot,
} from '@/data/onboarding-data';
import { OnboardingFrame } from './OnboardingFrame';
import {
  CheckRow,
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
          <View style={[styles.benefitIcon, { backgroundColor: colors.navy }]}>
            <Feather name={icons[i % icons.length]} size={13} color={colors.brandMarkText} />
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
        label="Connect health app"
        onPress={() => choose('connected')}
        style={styles.btnGap}
      />
      <GhostButton testID="ob-health-skip" label="Skip for now" onPress={() => choose('skipped')} />
      <View style={styles.noteGap}>
        <NoteText center text="Connection is simulated in this demo — no real health data is accessed." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

export function NotificationsStep() {
  const { patch } = useOnboarding();
  const flow = useOnboardingFlow('notifications');

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
        onPress={() => choose('enabled')}
        style={styles.btnGap}
      />
      <GhostButton testID="ob-notif-later" label="Maybe later" onPress={() => choose('later')} />
      <View style={styles.noteGap}>
        <NoteText center text="Simulated — you can change this anytime in settings." />
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

// ─── Diets ───────────────────────────────────────────────────────────────────

export function DietsStep() {
  const { answers, patch } = useOnboarding();

  const toggle = (key: string) => {
    if (key === DIET_NONE_KEY) {
      patch({ diets: answers.diets.includes(DIET_NONE_KEY) ? [] : [DIET_NONE_KEY] });
      return;
    }
    const without = answers.diets.filter(d => d !== DIET_NONE_KEY);
    patch({
      diets: without.includes(key) ? without.filter(d => d !== key) : [...without, key],
    });
  };

  return (
    <OnboardingFrame
      stepKey="diets"
      title="Any dietary preferences?"
      coach="Last question — this filters your recipes."
      nextDisabled={answers.diets.length === 0}
    >
      {DIET_OPTIONS.map(opt => (
        <CheckRow
          key={opt.key}
          testID={`ob-diet-${opt.key}`}
          label={opt.label}
          checked={answers.diets.includes(opt.key)}
          onPress={() => toggle(opt.key)}
        />
      ))}
      <CheckRow
        testID="ob-diet-none"
        label="None of the above"
        checked={answers.diets.includes(DIET_NONE_KEY)}
        onPress={() => toggle(DIET_NONE_KEY)}
      />
      <NoteText text="Select all that apply. You can update these anytime." />
    </OnboardingFrame>
  );
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
    { label: 'CONTACT', value: `${answers.contactValue || '—'} · Verified` },
    { label: 'PROVIDER', value: 'Linked to your care team' },
    {
      label: 'SECURITY',
      value: `Password set${answers.faceId === 'enabled' ? ' · Face ID on (simulated)' : ''}`,
    },
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
  if (onMeds) {
    rows.push({
      label: 'REMINDERS',
      value: `${answers.reminderMorning} · ${answers.reminderAfternoon} · ${answers.reminderEvening}`,
    });
  }
  rows.push(
    {
      label: 'HEALTH APP',
      value: answers.healthApp === 'connected' ? 'Connected (simulated)' : 'Skipped',
    },
    {
      label: 'NOTIFICATIONS',
      value: answers.notifications === 'enabled' ? 'Enabled' : 'Maybe later',
    },
    {
      label: 'DIETS',
      value: answers.diets.includes(DIET_NONE_KEY)
        ? 'None'
        : answers.diets
            .map(d => DIET_OPTIONS.find(o => o.key === d)?.label ?? d)
            .join(', ') || '—',
    },
  );

  const finish = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setMode('patient');
    router.replace('/today');
    // End the run after navigating: stale onboarding history now redirects to
    // a fresh welcome instead of re-opening the finished wizard.
    endRun();
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
      <NoteText text="Simulation complete — nothing was saved. You'll enter the demo patient account (Emma Smith) to explore the app." />
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
