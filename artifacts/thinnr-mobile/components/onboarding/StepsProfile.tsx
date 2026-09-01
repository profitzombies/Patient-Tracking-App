/**
 * Simulated onboarding — profile steps: height, weight, gender, birthday,
 * program, started-yet, start date, goal weight.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { PillSelector } from '@/components/ui/LedgerPrimitives';
import { LocalDatePicker } from '@/components/ui/LocalDatePicker';
import { useOnboarding } from '@/context/OnboardingContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import {
  MONTH_LABELS,
  parseWeight,
  PROGRAM_OPTIONS,
  QUICK_START_OFFSETS,
  isValidDateKey,
  localStartDateKeyFor,
  quickStartTitle,
  startDateLabelFor,
  validateBirthday,
  weightBounds,
  weightUnitFor,
  type HeightUnit,
  type YesNo,
} from '@/data/onboarding-data';
import { OnboardingFrame } from './OnboardingFrame';
import {
  BigNumberInput,
  CheckRow,
  ChipGrid,
  ChoiceCard,
  ErrorBox,
  FieldLabel,
  InfoCard,
  LedgerInput,
  NoteText,
  StepperRow,
} from './OnboardingFields';

// ─── Height ──────────────────────────────────────────────────────────────────

export function HeightStep() {
  const { answers, patch } = useOnboarding();
  const imperial = answers.heightUnit === 'imperial';

  return (
    <OnboardingFrame
      stepKey="height"
      title="How tall are you?"
      coach="Now let's build your profile so your targets fit you."
    >
      <PillSelector<HeightUnit>
        options={[
          { label: 'IMPERIAL', value: 'imperial' },
          { label: 'METRIC', value: 'metric' },
        ]}
        selected={answers.heightUnit}
        onSelect={v => patch({ heightUnit: v })}
        style={styles.blockGap}
      />
      {imperial ? (
        <>
          <StepperRow
            testID="ob-height-ft"
            label="Feet"
            display={`${answers.heightFt} ft`}
            onDec={() => patch({ heightFt: answers.heightFt - 1 })}
            onInc={() => patch({ heightFt: answers.heightFt + 1 })}
            decDisabled={answers.heightFt <= 3}
            incDisabled={answers.heightFt >= 7}
          />
          <StepperRow
            testID="ob-height-in"
            label="Inches"
            display={`${answers.heightIn} in`}
            onDec={() => patch({ heightIn: answers.heightIn - 1 })}
            onInc={() => patch({ heightIn: answers.heightIn + 1 })}
            decDisabled={answers.heightIn <= 0}
            incDisabled={answers.heightIn >= 11}
          />
        </>
      ) : (
        <StepperRow
          testID="ob-height-cm"
          label="Centimeters"
          display={`${answers.heightCm} cm`}
          onDec={() => patch({ heightCm: answers.heightCm - 1 })}
          onInc={() => patch({ heightCm: answers.heightCm + 1 })}
          decDisabled={answers.heightCm <= 120}
          incDisabled={answers.heightCm >= 220}
        />
      )}
      <NoteText text="Height and weight help estimate your daily energy needs (BMR)." />
    </OnboardingFrame>
  );
}

// ─── Current weight ──────────────────────────────────────────────────────────

export function WeightStep() {
  const { answers, patch } = useOnboarding();
  const unit = weightUnitFor(answers.heightUnit);
  const bounds = weightBounds(unit);
  const parsed = parseWeight(answers.currentWeight);
  const inRange = parsed !== null && parsed >= bounds.min && parsed <= bounds.max;
  const showError = answers.currentWeight.trim().length > 0 && !inRange;

  return (
    <OnboardingFrame
      stepKey="weight"
      title="What's your current weight?"
      coach="A starting point, not a judgment — this is day one."
      nextDisabled={!inRange}
      nextBlockedHint={
        parsed === null
          ? 'Enter your current weight to continue.'
          : `Enter a weight between ${bounds.min} and ${bounds.max} ${unit}.`
      }
    >
      <BigNumberInput
        testID="ob-weight-input"
        value={answers.currentWeight}
        onChangeText={v => patch({ currentWeight: v.replace(/[^0-9.]/g, '') })}
        unit={unit}
      />
      {showError ? (
        <View style={styles.blockGapTop}>
          <ErrorBox message={`Enter a weight between ${bounds.min} and ${bounds.max} ${unit}.`} />
        </View>
      ) : null}
      <View style={styles.blockGapTop}>
        <NoteText text="Weigh-ins stay private to you and your care team." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Gender ──────────────────────────────────────────────────────────────────

export function GenderStep() {
  const { answers, patch } = useOnboarding();

  return (
    <OnboardingFrame
      stepKey="gender"
      title="Which best describes you?"
      coach="Almost through the basics."
      nextDisabled={!answers.gender}
      nextBlockedHint="Choose one option to continue."
    >
      <ChoiceCard
        testID="ob-gender-female"
        title="Female"
        selected={answers.gender === 'female'}
        onPress={() => patch({ gender: 'female' })}
      />
      <ChoiceCard
        testID="ob-gender-male"
        title="Male"
        selected={answers.gender === 'male'}
        onPress={() => patch({ gender: 'male' })}
      />
      <View style={styles.blockGapTop}>
        <InfoCard
          label="Why we ask"
          body="Biological sex affects how we estimate your metabolism and dosing guidance. Your answer stays private to you and your care team."
        />
      </View>
    </OnboardingFrame>
  );
}

// ─── Birthday ────────────────────────────────────────────────────────────────

export function BirthdayStep() {
  const { answers, patch } = useOnboarding();
  const { account } = usePatientAccount();
  const { complete, error } = validateBirthday(
    answers.birthMonth,
    answers.birthDay,
    answers.birthYear,
    account.kind === 'real',
  );

  return (
    <OnboardingFrame
      stepKey="birthday"
      title="When were you born?"
      coach="Age is part of the same energy math."
      nextDisabled={!complete || error !== null}
      nextBlockedHint={error ?? 'Fill in your birth month, day, and year to continue.'}
    >
      <FieldLabel text="Month" />
      <ChipGrid
        options={MONTH_LABELS.map((label, i) => ({ label, value: String(i + 1) }))}
        value={answers.birthMonth ? String(answers.birthMonth) : null}
        onChange={v => patch({ birthMonth: Number(v) })}
        testIDPrefix="ob-month"
        basis="22%"
      />
      <View style={[styles.row, styles.blockGapTop]}>
        <View style={styles.rowItem}>
          <FieldLabel text="Day" />
          <LedgerInput
            testID="ob-day-input"
            value={answers.birthDay}
            onChangeText={v => patch({ birthDay: v.replace(/\D/g, '').slice(0, 2) })}
            keyboardType="number-pad"
            autoFocus
            maxLength={2}
            placeholder="DD"
          />
        </View>
        <View style={styles.rowItem}>
          <FieldLabel text="Year" />
          <LedgerInput
            testID="ob-year-input"
            value={answers.birthYear}
            onChangeText={v => patch({ birthYear: v.replace(/\D/g, '').slice(0, 4) })}
            keyboardType="number-pad"
            maxLength={4}
            placeholder="YYYY"
          />
        </View>
      </View>
      {complete && error ? (
        <View style={styles.blockGapTop}>
          <ErrorBox testID="ob-birthday-error" message={error} />
        </View>
      ) : null}
      <View style={styles.blockGapTop}>
        <NoteText text="Used only to personalize your plan. Members must be 18 or older." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Program ─────────────────────────────────────────────────────────────────

export function ProgramStep() {
  const { answers, patch } = useOnboarding();

  return (
    <OnboardingFrame
      stepKey="program"
      title="Which program are you on?"
      coach="This shapes your reminders and check-ins."
      nextDisabled={!answers.program}
      nextBlockedHint="Choose a program to continue."
    >
      {PROGRAM_OPTIONS.map(opt => (
        <ChoiceCard
          key={opt.key}
          testID={`ob-program-${opt.key}`}
          icon={opt.icon}
          title={opt.title}
          body={opt.body}
          selected={answers.program === opt.key}
          onPress={() => patch({ program: opt.key })}
        />
      ))}
      <NoteText text="You can change this anytime with your care team." />
    </OnboardingFrame>
  );
}

// ─── Started yet? ────────────────────────────────────────────────────────────

export function StartedStep() {
  const { answers, patch } = useOnboarding();
  const { account } = usePatientAccount();
  const choose = (started: YesNo) =>
    patch({
      started,
      ...(account.kind === 'real' ? { programStartDate: localStartDateKeyFor(0) } : {}),
    });

  return (
    <OnboardingFrame
      stepKey="started"
      title="Have you started your program?"
      coach="No wrong answer — this just tells us where to pick up."
      nextDisabled={!answers.started}
      nextBlockedHint="Choose Yes or Not yet to continue."
    >
      <ChoiceCard
        testID="ob-started-yes"
        title="Yes"
        body="I've already taken my first dose."
        selected={answers.started === 'yes'}
        onPress={() => choose('yes')}
      />
      <ChoiceCard
        testID="ob-started-no"
        title="Not yet"
        body="I'm getting ready to begin."
        selected={answers.started === 'no'}
        onPress={() => choose('no')}
      />
      {answers.started === 'no' ? (
        <View style={styles.blockGapTop}>
          <InfoCard label="No problem" body="We'll help you line up your first dose on the next step." />
        </View>
      ) : null}
    </OnboardingFrame>
  );
}

// ─── Start date ──────────────────────────────────────────────────────────────

export function StartDateStep() {
  const { answers, patch } = useOnboarding();
  const { account } = usePatientAccount();
  const real = account.kind === 'real';
  const selectedKey = real
    ? answers.programStartDate || localStartDateKeyFor(0)
    : startDateLabelFor(answers.startOffsetDays);
  const chooseOffset = (offset: number) =>
    patch(
      real
        ? { startOffsetDays: offset, programStartDate: localStartDateKeyFor(offset) }
        : { startOffsetDays: offset },
    );
  const valid = !real || isValidDateKey(answers.programStartDate);
  const todayKey = localStartDateKeyFor(0);
  const minDate = answers.started === 'yes' ? '2020-01-01' : todayKey;
  const maxDate = answers.started === 'yes' ? todayKey : localStartDateKeyFor(365);
  const labelForKey = (key: string) =>
    new Date(`${key}T12:00:00`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  return (
    <OnboardingFrame
      stepKey="start-date"
      title={real && answers.started === 'yes' ? 'When did you start?' : 'When will you start?'}
      coach="Pick the calendar day so your program timing stays accurate."
    >
      {(real && answers.started === 'yes' ? [0, -1, -7, -14] : QUICK_START_OFFSETS).map(offset => (
        <CheckRow
          key={offset}
          testID={`ob-date-row-${offset}`}
          label={
            real && answers.started === 'yes'
              ? offset === 0
                ? 'Today'
                : offset === -1
                  ? 'Yesterday'
                  : `${Math.abs(offset)} days ago`
              : quickStartTitle(offset)
          }
          sub={real ? labelForKey(localStartDateKeyFor(offset)) : startDateLabelFor(offset)}
          checked={
            real
              ? selectedKey === localStartDateKeyFor(offset)
              : answers.startOffsetDays === offset
          }
          onPress={() => chooseOffset(offset)}
        />
      ))}
      <View style={styles.blockGapTop}>
        {real ? (
          <>
            <FieldLabel text="Or choose any date" />
            <LocalDatePicker
              testID="ob-start-date-calendar"
              value={answers.programStartDate}
              onChange={programStartDate => patch({ programStartDate })}
              minDate={minDate}
              maxDate={maxDate}
            />
            <View style={styles.blockGapTop}>
              <InfoCard
                label="Planned start"
                body={valid ? labelForKey(answers.programStartDate) : 'Choose a calendar date above.'}
              />
            </View>
          </>
        ) : (
          <>
            <StepperRow
              testID="ob-date-step"
              label="Or pick any day"
              display={`+${answers.startOffsetDays}d`}
              onDec={() => patch({ startOffsetDays: answers.startOffsetDays - 1 })}
              onInc={() => patch({ startOffsetDays: answers.startOffsetDays + 1 })}
              decDisabled={answers.startOffsetDays <= 0}
              incDisabled={answers.startOffsetDays >= 60}
            />
            <InfoCard label="Planned start" body={startDateLabelFor(answers.startOffsetDays, true)} />
          </>
        )}
      </View>
    </OnboardingFrame>
  );
}

// ─── Goal weight ─────────────────────────────────────────────────────────────

export function GoalWeightStep() {
  const { answers, patch } = useOnboarding();
  const unit = weightUnitFor(answers.heightUnit);
  const bounds = weightBounds(unit);
  const current = parseWeight(answers.currentWeight);
  const goal = parseWeight(answers.goalWeight);

  let error: string | null = null;
  if (answers.goalWeight.trim().length > 0) {
    if (goal === null || goal < bounds.min) {
      error = `Enter a goal of at least ${bounds.min} ${unit}.`;
    } else if (current !== null && goal >= current) {
      error = `Set a goal below your current weight of ${current} ${unit}.`;
    }
  }
  const valid = goal !== null && error === null;

  return (
    <OnboardingFrame
      stepKey="goal-weight"
      title="What's your goal weight?"
      coach="Ambitious is fine — your care team refines this with you."
      nextDisabled={!valid}
      nextBlockedHint={error ?? 'Enter your goal weight to continue.'}
    >
      <BigNumberInput
        testID="ob-goal-input"
        value={answers.goalWeight}
        onChangeText={v => patch({ goalWeight: v.replace(/[^0-9.]/g, '') })}
        unit={unit}
      />
      {error ? (
        <View style={styles.blockGapTop}>
          <ErrorBox testID="ob-goal-error" message={error} />
        </View>
      ) : null}
      <View style={styles.blockGapTop}>
        <NoteText text="Goals adjust as you go — nothing is locked in today." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  blockGap: {
    marginBottom: 16,
  },
  blockGapTop: {
    marginTop: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  rowItem: {
    flex: 1,
  },
});
