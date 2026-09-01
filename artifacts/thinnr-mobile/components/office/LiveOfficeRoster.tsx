/**
 * Live office roster + patient invitation UI for the staff Patients screen.
 *
 * Server truth gates everything: the section mounts only after the roster
 * endpoint accepts the signed-in staff member's bearer token, so the demo
 * persona (no session) and patient sessions (403) never see live UI and the
 * seeded roster stays untouched. The office itself is always derived
 * server-side from the token — this surface never names one.
 *
 * Invitation state derives from the row: pending until the patient's first
 * phone-verified sign-in links a login (verified). A failed email is durable
 * row state and surfaces a Resend action here.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { AppModal } from '@/components/ui/AppModal';
import {
  ErrorBox,
  FieldLabel,
  GhostButton,
  LedgerInput,
  PrimaryButton,
} from '@/components/onboarding/OnboardingFields';
import {
  fetchOfficeRoster,
  formatUsPhoneInput,
  invitePatient,
  resendInvitation,
  validateInviteForm,
  OfficeRosterError,
  type InvitationEmailOutcome,
  type InvitePatientInput,
  type OfficePatient,
  type OfficeRosterData,
} from '@/lib/office-roster-api';

export type OfficeRosterStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface OfficeRosterState {
  status: OfficeRosterStatus;
  roster: OfficeRosterData | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Load the live roster for the signed-in staff member. `unavailable` means
 * this session has no live office (demo persona, patient token, or live
 * rosters not configured) — callers hide the live UI entirely.
 */
export function useOfficeRoster(): OfficeRosterState {
  const [status, setStatus] = useState<OfficeRosterStatus>('loading');
  const [roster, setRoster] = useState<OfficeRosterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchOfficeRoster();
      if (!mounted.current) return;
      setRoster(data);
      setError(null);
      setStatus('ready');
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof OfficeRosterError && (err.status === 401 || err.status === 403 || err.status === 503)) {
        setStatus('unavailable');
        return;
      }
      setError(err instanceof Error ? err.message : 'The live roster could not be loaded.');
      // Keep any roster we already had; the message rides alongside it.
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, roster, error, refresh };
}

const EMPTY_FORM: InvitePatientInput = { firstName: '', lastName: '', email: '', phone: '' };

interface InvitePatientModalProps {
  visible: boolean;
  onClose: () => void;
  /** Fires after the invitation lands (row created); email may still have failed. */
  onInvited: (patient: OfficePatient, outcome: InvitationEmailOutcome) => void;
}

export function InvitePatientModal({ visible, onClose, onInvited }: InvitePatientModalProps) {
  const colors = useColors();
  const [form, setForm] = useState<InvitePatientInput>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof InvitePatientInput, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setSubmitError(null);
    onClose();
  };

  const setField = (field: keyof InvitePatientInput) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: field === 'phone' ? formatUsPhoneInput(value) : value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    setSubmitError(null);
  };

  const submit = async () => {
    const found = validateInviteForm(form);
    if (Object.values(found).some(Boolean)) {
      setErrors(found);
      return;
    }
    setPending(true);
    setSubmitError(null);
    try {
      const result = await invitePatient({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setForm(EMPTY_FORM);
      setErrors({});
      onInvited(result.patient, result.invitation);
      onClose();
    } catch (error) {
      if (
        error instanceof OfficeRosterError &&
        error.field &&
        error.field in EMPTY_FORM
      ) {
        setErrors({ [error.field]: error.message });
      } else {
        setSubmitError(error instanceof Error ? error.message : 'Could not send the invitation. Try again.');
      }
    } finally {
      setPending(false);
    }
  };

  const field = (
    key: keyof InvitePatientInput,
    label: string,
    inputProps: { placeholder: string; keyboardType?: 'email-address' | 'phone-pad'; autoCapitalize?: 'none' | 'words' },
  ) => (
    <View style={styles.fieldBlock}>
      <FieldLabel text={label} />
      <LedgerInput
        value={form[key]}
        onChangeText={setField(key)}
        placeholder={inputProps.placeholder}
        keyboardType={inputProps.keyboardType}
        autoCapitalize={inputProps.autoCapitalize ?? 'words'}
        autoCorrect={false}
        editable={!pending}
        testID={`invite-patient-${key}`}
      />
      {errors[key] ? (
        <Text
          style={[styles.fieldError, { color: colors.destructive }]}
          accessibilityLiveRegion="polite"
          testID={`invite-patient-${key}-error`}
        >
          {errors[key]}
        </Text>
      ) : null}
    </View>
  );

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.avoider}
        >
          <View
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            testID="invite-patient-modal"
          >
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.cardInner}>
              <Text style={[styles.title, { color: colors.navy }]}>Invite a patient</Text>
              <Text style={[styles.sub, { color: colors.subtleText }]}>
                They’ll get a THINNR email invitation and connect to your office automatically by
                signing in to the app with this phone number.
              </Text>
              <View style={styles.nameRow}>
                <View style={styles.nameCol}>{field('firstName', 'First name', { placeholder: 'Jordan' })}</View>
                <View style={styles.nameCol}>{field('lastName', 'Last name', { placeholder: 'Ellis' })}</View>
              </View>
              {field('email', 'Email', { placeholder: 'name@example.com', keyboardType: 'email-address', autoCapitalize: 'none' })}
              {field('phone', 'US mobile number', { placeholder: '(555) 201-7788', keyboardType: 'phone-pad', autoCapitalize: 'none' })}
              {submitError ? <ErrorBox message={submitError} testID="invite-patient-error" /> : null}
              <PrimaryButton
                label={pending ? 'Sending…' : 'Send invitation'}
                onPress={() => void submit()}
                disabled={pending}
                testID="invite-patient-submit"
                style={styles.submitBtn}
              />
              <GhostButton label="Cancel" onPress={close} testID="invite-patient-cancel" style={styles.cancelBtn} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </AppModal>
  );
}

function InvitationChip({ patient }: { patient: OfficePatient }) {
  const colors = useColors();
  if (!patient.invitation) return null;
  const pending = patient.invitation.state === 'pending';
  return (
    <View
      style={[
        styles.chip,
        pending
          ? { borderColor: '#e8b47c', backgroundColor: '#fff4e6' }
          : { borderColor: colors.activeBorder ?? colors.border, backgroundColor: colors.activeBg },
      ]}
    >
      <Text style={[styles.chipText, { color: pending ? '#b65c22' : colors.cobalt }]}>
        {pending ? 'INVITE PENDING' : 'VERIFIED'}
      </Text>
    </View>
  );
}

interface LiveRosterSectionProps {
  state: OfficeRosterState;
  /** Snackbar-style feedback line owned by the screen. */
  onNotice: (notice: string) => void;
}

/** The live patients list rendered above the seeded roster for staff sessions. */
export function LiveRosterSection({ state, onNotice }: LiveRosterSectionProps) {
  const colors = useColors();
  const [resending, setResending] = useState<string | null>(null);

  if (state.status === 'unavailable' || state.status === 'loading') return null;

  const resend = async (patient: OfficePatient) => {
    setResending(patient.id);
    try {
      const result = await resendInvitation(patient.id);
      await state.refresh();
      onNotice(
        result.invitation === 'sent'
          ? `Invitation resent to ${patient.name}.`
          : `The email to ${patient.name} didn’t go out. Try Resend again shortly.`,
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Invitation not resent. Try again.');
    } finally {
      setResending(null);
    }
  };

  return (
    <View
      style={[styles.section, { borderColor: colors.border, backgroundColor: colors.card }]}
      testID="live-roster-section"
    >
      <View style={[styles.sectionHead, { borderBottomColor: colors.divider, backgroundColor: colors.paperCardAlt }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>Live roster</Text>
          <Text style={[styles.sectionSub, { color: colors.subtleText }]} numberOfLines={2}>
            {state.roster
              ? `${state.roster.office.officeName} — provider code ${state.roster.office.providerCode}`
              : 'Patients connected to your office.'}
          </Text>
        </View>
      </View>
      {state.status === 'error' && state.error ? (
        <Text style={[styles.sectionError, { color: colors.destructive }]} accessibilityLiveRegion="polite">
          {state.error}
        </Text>
      ) : null}
      {state.roster && state.roster.patients.length === 0 ? (
        <Text style={[styles.emptyText, { color: colors.subtleText }]}>
          No live patients yet. Use the invite button above to add the first one.
        </Text>
      ) : null}
      {state.roster?.patients.map((patient, index) => (
        <View
          key={patient.id}
          style={[styles.rosterRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
          testID={`live-roster-row-${patient.id}`}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.rowName, { color: colors.navy }]} numberOfLines={1}>
              {patient.name}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.subtleText }]} numberOfLines={1}>
              {patient.phoneDisplay ?? patient.phone ?? ''}
              {patient.email ? ` · ${patient.email}` : ''}
            </Text>
            {patient.invitation?.emailStatus === 'failed' && patient.invitation.state === 'pending' ? (
              <Text style={[styles.rowMeta, { color: colors.destructive, marginTop: 2 }]}>
                Invitation email failed — resend it.
              </Text>
            ) : null}
          </View>
          <View style={styles.rowRight}>
            <InvitationChip patient={patient} />
            {patient.invitation?.state === 'pending' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Resend invitation to ${patient.name}`}
                disabled={resending === patient.id}
                onPress={() => void resend(patient)}
                style={({ pressed }) => [
                  styles.resendBtn,
                  { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                  resending === patient.id && { opacity: 0.5 },
                ]}
                testID={`resend-invite-${patient.id}`}
              >
                <Text style={[styles.resendText, { color: colors.cobalt }]}>
                  {resending === patient.id ? 'Resending…' : 'Resend'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(21, 32, 46, 0.45)',
    justifyContent: 'center',
    padding: 20,
  },
  avoider: { width: '100%' },
  card: {
    borderWidth: 1,
    borderRadius: theme.radius,
    maxHeight: 560,
    overflow: 'hidden',
  },
  cardInner: { padding: 18 },
  title: { fontSize: 20, fontFamily: fonts.serif },
  sub: { fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 14, fontFamily: 'Inter_400Regular' },
  nameRow: { flexDirection: 'row', gap: 10 },
  nameCol: { flex: 1 },
  fieldBlock: { marginBottom: 12 },
  fieldError: { fontSize: 11, marginTop: 4, fontFamily: 'Inter_500Medium' },
  submitBtn: { marginTop: 4 },
  cancelBtn: { marginTop: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  chipText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'Inter_700Bold' },
  section: {
    borderWidth: 1,
    borderRadius: theme.radius,
    marginHorizontal: 14,
    marginTop: 12,
    marginBottom: 4,
    overflow: 'hidden',
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  sectionTitle: { fontSize: 15, fontFamily: fonts.serif },
  sectionSub: { fontSize: 10, marginTop: 2, fontFamily: 'Inter_400Regular' },
  sectionError: { fontSize: 11, paddingHorizontal: 14, paddingVertical: 10, fontFamily: 'Inter_500Medium' },
  emptyText: { fontSize: 11, paddingHorizontal: 14, paddingVertical: 14, fontFamily: 'Inter_400Regular' },
  rosterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowName: { fontSize: 14, fontFamily: fonts.serif },
  rowMeta: { fontSize: 10, marginTop: 2, fontFamily: 'Inter_400Regular' },
  rowRight: { alignItems: 'flex-end', gap: 6 },
  resendBtn: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  resendText: { fontSize: 10, fontWeight: '700', fontFamily: 'Inter_700Bold' },
});
