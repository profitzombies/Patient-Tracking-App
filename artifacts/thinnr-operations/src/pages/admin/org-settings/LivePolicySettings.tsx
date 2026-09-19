/**
 * Live (signed-in) organization policy sections for the HQ settings page.
 *
 * One card per policy section — organization profile, coach & care team,
 * notification defaults, conversations, retention & exports — each with its
 * own draft, Save/Reset, and a "last changed by … · when" stamp fed by the
 * server's per-section change metadata. Every save sends only the section's
 * fields plus the version it was read at; a stale version comes back 409 and
 * the card reloads instead of overwriting a teammate's change.
 *
 * The guided-demo persona never reaches this file — OrgSettings renders the
 * seeded, session-only GroupCards for it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, QrCode, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetHqSettingsQueryKey,
  useGetHqSettings,
  useUpdateHqSettings,
  type HqOrganizationSettings,
  type HqOrganizationSettingsInput,
  type QuietHoursWindow,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BTN_PRIMARY, INPUT_CLASS, LINK_ACTION, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { useSession } from '@/contexts/session';
import {
  APP_STORE_LABELS,
  POLICY_BOUNDS,
  apiErrorMessage,
  apiErrorStatus,
  describeSectionChange,
  storeLinkProblem,
  type AppStoreKind,
  type PolicySectionKey,
} from '@/lib/org-policy';

export const HQ_TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'UTC', label: 'UTC' },
];

// ─── Shared row + card chrome ────────────────────────────────────────────────

function FieldRow({ label, help, children, last = false }: { label: string; help: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4 ${last ? '' : 'border-b border-border'}`}>
      <div className="min-w-0 max-w-[46ch]">
        <p className={PANEL_LABEL}>{label}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{help}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NumberField({ id, label, value, bounds, unit, problem, onChange }: {
  id: string;
  label: string;
  value: number;
  bounds: { min: number; max: number };
  unit: string;
  problem?: string | null;
  onChange: (next: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
        type="number"
        inputMode="numeric"
        className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
        value={Number.isFinite(value) ? value : ''}
        min={bounds.min}
        max={bounds.max}
        step={1}
        onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
        aria-label={label}
        aria-describedby={`${id}-range`}
          data-testid={id}
          aria-invalid={problem ? true : undefined}
        />
        <span id={`${id}-range`} className="text-[11px] text-muted-foreground">
          {unit} · {bounds.min}–{bounds.max}
        </span>
      </div>
      {problem && <p className="mt-1 text-[11px] font-medium text-destructive" role="alert">{problem}</p>}
    </div>
  );
}

function QuietHoursFields({ idPrefix, value, onChange }: {
  idPrefix: string;
  value: QuietHoursWindow | null;
  onChange: (next: QuietHoursWindow | null) => void;
}) {
  const enabled = value !== null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => onChange(checked ? { start: value?.start ?? '21:00', end: value?.end ?? '08:00' } : null)}
        aria-label="Quiet hours on"
        data-testid={`${idPrefix}-enabled`}
      />
      {enabled && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="time"
            className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
            value={value.start}
            onChange={(event) => onChange({ start: event.target.value, end: value.end })}
            aria-label="Quiet hours start"
            data-testid={`${idPrefix}-start`}
          />
          <span>to</span>
          <input
            type="time"
            className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
            value={value.end}
            onChange={(event) => onChange({ start: value.start, end: event.target.value })}
            aria-label="Quiet hours end"
            data-testid={`${idPrefix}-end`}
          />
        </div>
      )}
    </div>
  );
}

interface PolicyCardProps<Draft> {
  section: PolicySectionKey;
  title: string;
  sub: string;
  settings: HqOrganizationSettings;
  /** Slice of the saved settings this card edits. */
  fromSettings: (settings: HqOrganizationSettings) => Draft;
  /** Draft → the partial API payload (fields only; version is added here). */
  toPayload: (draft: Draft) => HqOrganizationSettingsInput;
  /** Client-side completeness check (blank number inputs); server still validates bounds. */
  incomplete?: (draft: Draft) => string | null;
  children: (draft: Draft, setDraft: (patch: Partial<Draft>) => void) => ReactNode;
}

/**
 * One policy section: drafts start from the saved slice, Save posts the
 * slice with `expectedVersion`, a 409 reloads the whole settings object (the
 * other cards pick up the fresh version too) and tells the admin why.
 */
function PolicyCard<Draft extends object>({ section, title, sub, settings, fromSettings, toPayload, incomplete, children }: PolicyCardProps<Draft>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateHqSettings();
  const saved = useMemo(() => fromSettings(settings), [fromSettings, settings]);
  const [draft, setDraftState] = useState<Draft>(saved);
  const [savedSnapshot, setSavedSnapshot] = useState(saved);
  // Re-seed the draft whenever the server copy changes (initial load, a
  // successful save, or the reload after a 409) — never while typing.
  if (savedSnapshot !== saved) {
    setSavedSnapshot(saved);
    setDraftState(saved);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const blocker = incomplete?.(draft) ?? null;
  const setDraft = (patch: Partial<Draft>) => setDraftState((current) => ({ ...current, ...patch }));

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetHqSettingsQueryKey() });

  const save = () => {
    if (blocker) {
      toast({ variant: 'destructive', title: `${title} not saved`, description: blocker });
      return;
    }
    update.mutate(
      { data: { ...toPayload(draft), expectedVersion: settings.version } },
      {
        onSuccess: () => {
          void refresh();
          toast({ variant: 'success', title: `${title} saved`, description: 'Applied live — every system that reads this policy sees it now.' });
        },
        onError: (error) => {
          if (apiErrorStatus(error) === 409) {
            void refresh();
            toast({
              variant: 'destructive',
              title: 'Someone else saved first',
              description: 'These settings changed while you were editing. The latest values have been reloaded — re-apply your change if it still stands.',
            });
            return;
          }
          toast({ variant: 'destructive', title: `${title} not saved`, description: apiErrorMessage(error, 'Could not apply changes. Please try again.') });
        },
      },
    );
  };

  const reset = () => {
    setDraftState(saved);
    toast({ variant: 'success', title: 'Draft discarded', description: 'Back to the saved values.' });
  };

  return (
    <SectionCard
      title={title}
      sub={
        <>
          {sub}
          <span className="mt-1 block text-[11px] text-muted-foreground/80" data-testid={`policy-stamp-${section}`}>
            {describeSectionChange(settings.sections[section])}
          </span>
        </>
      }
      action={
        <div className="flex items-center gap-3">
          <button type="button" className={`${LINK_ACTION} inline-flex items-center gap-1`} onClick={reset} aria-label={`Discard ${title} changes`} disabled={!dirty || update.isPending}>
            <RotateCcw size={12} aria-hidden="true" />
            Reset
          </button>
          <button
            type="button"
            className={`${BTN_PRIMARY} h-8 px-3 disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={!dirty || update.isPending}
            data-testid={`button-save-policy-${section}`}
            onClick={save}
          >
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Saving" /> : 'Save'}
          </button>
        </div>
      }
    >
      <div>{children(draft, setDraft)}</div>
    </SectionCard>
  );
}

// ─── Section drafts ──────────────────────────────────────────────────────────

interface OrganizationDraft {
  organizationName: string;
  supportEmail: string;
  supportPhone: string;
  defaultTimezone: string;
  appStoreUrl: string;
  googlePlayUrl: string;
}
const organizationFrom = (s: HqOrganizationSettings): OrganizationDraft => ({
  organizationName: s.organizationName,
  supportEmail: s.supportEmail ?? '',
  supportPhone: s.supportPhone ?? '',
  defaultTimezone: s.defaultTimezone,
  appStoreUrl: s.appStoreUrl ?? '',
  googlePlayUrl: s.googlePlayUrl ?? '',
});
const organizationPayload = (d: OrganizationDraft): HqOrganizationSettingsInput => ({
  organizationName: d.organizationName,
  supportEmail: d.supportEmail.trim() || null,
  supportPhone: d.supportPhone.trim() || null,
  defaultTimezone: d.defaultTimezone,
  appStoreUrl: d.appStoreUrl.trim() || null,
  googlePlayUrl: d.googlePlayUrl.trim() || null,
});
/** A malformed store link blocks Save with the same message shown inline. */
const organizationIncomplete = (d: OrganizationDraft): string | null =>
  storeLinkProblem('appStore', d.appStoreUrl) ?? storeLinkProblem('googlePlay', d.googlePlayUrl);

const STORE_LINK_FIELDS: Array<{ kind: AppStoreKind; key: 'appStoreUrl' | 'googlePlayUrl'; testId: string; placeholder: string; help: string }> = [
  {
    kind: 'appStore', key: 'appStoreUrl', testId: 'input-setting-live-app-store-url',
    placeholder: 'https://apps.apple.com/us/app/thinnr/id…',
    help: 'The App Store listing. Every office’s “Get the app” panel renders its iPhone QR code from this link.',
  },
  {
    kind: 'googlePlay', key: 'googlePlayUrl', testId: 'input-setting-live-google-play-url',
    placeholder: 'https://play.google.com/store/apps/details?id=…',
    help: 'The Google Play listing. Every office’s “Get the app” panel renders its Android QR code from this link.',
  },
];

/** Inline field for one store link: a shape hint while typing, a reminder while blank. */
function StoreLinkField({ kind, value, saved, testId, placeholder, onChange }: {
  kind: AppStoreKind;
  value: string;
  saved: string | null;
  testId: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const problem = storeLinkProblem(kind, value);
  const label = `${APP_STORE_LABELS[kind].store} link`;
  return (
    <div className="w-full sm:w-[26rem]">
      <input
        className={`${INPUT_CLASS} h-9 w-full`}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${testId}-problem` : !saved ? `${testId}-missing` : undefined}
        data-testid={testId}
      />
      {problem ? (
        <p id={`${testId}-problem`} className="mt-1 text-[11px] font-medium text-destructive" role="alert" data-testid={`${testId}-problem`}>
          {problem}
        </p>
      ) : !saved ? (
        <p id={`${testId}-missing`} className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[#b65c22]" data-testid={`${testId}-missing`}>
          <QrCode size={11} aria-hidden="true" />
          Not added yet — offices see “HQ hasn’t added this link yet” instead of a QR code.
        </p>
      ) : null}
    </div>
  );
}

interface CoachDraft { coachAvailable: boolean; escalationEmail: string }
const coachFrom = (s: HqOrganizationSettings): CoachDraft => ({ coachAvailable: s.coachAvailable, escalationEmail: s.escalationEmail ?? '' });
const coachPayload = (d: CoachDraft): HqOrganizationSettingsInput => ({ coachAvailable: d.coachAvailable, escalationEmail: d.escalationEmail.trim() || null });

interface NotificationsDraft {
  coachOutreach: boolean;
  checkInReminders: boolean;
  officeReminders: boolean;
  quietHours: QuietHoursWindow | null;
  outreachCooldownDays: number;
  outreachDailyCap: number;
}
const notificationsFrom = (s: HqOrganizationSettings): NotificationsDraft => ({
  coachOutreach: s.defaultCategories.coachOutreach,
  checkInReminders: s.defaultCategories.checkInReminders,
  officeReminders: s.defaultCategories.officeReminders,
  quietHours: s.defaultQuietHours ? { start: s.defaultQuietHours.start, end: s.defaultQuietHours.end } : null,
  outreachCooldownDays: s.outreachCooldownDays,
  outreachDailyCap: s.outreachDailyCap,
});
const notificationsPayload = (d: NotificationsDraft): HqOrganizationSettingsInput => ({
  defaultCategories: { coachOutreach: d.coachOutreach, checkInReminders: d.checkInReminders, officeReminders: d.officeReminders },
  defaultQuietHours: d.quietHours,
  outreachCooldownDays: d.outreachCooldownDays,
  outreachDailyCap: d.outreachDailyCap,
});

interface ConversationsDraft { conversationAutoCloseDays: number }
const conversationsFrom = (s: HqOrganizationSettings): ConversationsDraft => ({ conversationAutoCloseDays: s.conversationAutoCloseDays });
const conversationsPayload = (d: ConversationsDraft): HqOrganizationSettingsInput => ({ conversationAutoCloseDays: d.conversationAutoCloseDays });

interface RetentionDraft {
  chatTranscriptDays: number;
  progressPhotoDays: number;
  notificationHistoryDays: number;
  auditEventDays: number;
  jobRunDays: number;
  signInDays: number;
  webhookEventDays: number;
  clinicalRecordDays: number;
  exportLinkHours: number;
}
const retentionFrom = (s: HqOrganizationSettings): RetentionDraft => ({ ...s.retention, exportLinkHours: s.exportLinkHours });
const retentionPayload = (d: RetentionDraft): HqOrganizationSettingsInput => ({
  retention: {
    chatTranscriptDays: d.chatTranscriptDays,
    progressPhotoDays: d.progressPhotoDays,
    notificationHistoryDays: d.notificationHistoryDays,
    auditEventDays: d.auditEventDays,
    jobRunDays: d.jobRunDays,
    signInDays: d.signInDays,
    webhookEventDays: d.webhookEventDays,
    clinicalRecordDays: d.clinicalRecordDays,
  },
  exportLinkHours: d.exportLinkHours,
});

interface ArchiveDraft { coldArchiveEnabled: boolean }

interface SecurityDraft {
  staffIdleTimeoutMinutes: number;
  hqIdleTimeoutMinutes: number;
  hqUsers: boolean;
  officeManagers: boolean;
  allStaff: boolean;
}
const numbersComplete = (values: number[]) => (values.every((value) => Number.isFinite(value)) ? null : 'Every number needs a value before saving.');

// ─── The page body ───────────────────────────────────────────────────────────

export function LivePolicySettings() {
  const { authStatus, hqRole, authUser } = useSession();
  const isLive = authStatus === 'signed-in';
  const canEdit = isLive && (hqRole === 'Admin' || hqRole === 'Super Admin');

  const { data: settings, isLoading, isError, refetch } = useGetHqSettings({
    query: {
      enabled: canEdit,
      queryKey: [...getGetHqSettingsQueryKey(), authUser?.id],
    },
  });

  // A failed load retries once the tab regains focus; the copy below tells
  // the admin nothing is editable until it does.
  useEffect(() => {
    if (!isError) return;
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isError, refetch]);

  if (!isLive) return null;

  if (!canEdit) {
    return (
      <SectionCard title="Organization policies" sub="Program-wide switches every provider account inherits.">
        <div className="px-5 py-8 text-center text-sm text-muted-foreground" data-testid="policy-access-notice">
          You need Admin or Super Admin access to view or change these settings.
        </div>
      </SectionCard>
    );
  }

  if (isLoading) {
    return (
      <SectionCard title="Organization policies" sub="Loading live settings…">
        <div className="flex items-center justify-center p-8" role="status" aria-label="Loading settings">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </SectionCard>
    );
  }

  if (isError || !settings) {
    return (
      <SectionCard title="Organization policies" sub="Program-wide switches every provider account inherits.">
        <div className="px-5 py-8 text-center text-sm text-destructive" role="alert" data-testid="policy-load-error">
          Could not load the organization settings. Nothing here is editable until they load — refresh to try again.
        </div>
      </SectionCard>
    );
  }

  return (
    <>
      <PolicyCard
        section="organization"
        title="Organization profile"
        sub="How THINNR appears across HQ tools and provider-facing emails."
        settings={settings}
        fromSettings={organizationFrom}
        toPayload={organizationPayload}
        incomplete={organizationIncomplete}
      >
        {(draft, setDraft) => (
          <>
            <FieldRow label="Organization name" help="Shown in report headers and provider onboarding material.">
              <input className={`${INPUT_CLASS} h-9 w-full sm:w-72`} value={draft.organizationName} placeholder="THINNR, Inc." onChange={(e) => setDraft({ organizationName: e.target.value })} aria-label="Organization name" data-testid="input-setting-live-org-name" />
            </FieldRow>
            <FieldRow label="Support email" help="Where provider offices reach HQ.">
              <input className={`${INPUT_CLASS} h-9 w-full sm:w-72`} type="email" value={draft.supportEmail} placeholder="support@thinnr.example.com" onChange={(e) => setDraft({ supportEmail: e.target.value })} aria-label="Support email" data-testid="input-setting-live-support-email" />
            </FieldRow>
            <FieldRow label="Support phone" help="Optional contact number for provider support.">
              <input className={`${INPUT_CLASS} h-9 w-full sm:w-72`} value={draft.supportPhone} placeholder="(800) 555-0199" onChange={(e) => setDraft({ supportPhone: e.target.value })} aria-label="Support phone" data-testid="input-setting-live-support-phone" />
            </FieldRow>
            <FieldRow label="Reporting timezone" help="Display label for live rollup reports.">
              <Select value={draft.defaultTimezone} onValueChange={(value) => setDraft({ defaultTimezone: value })}>
                <SelectTrigger className="h-9 w-full text-xs sm:w-72" aria-label="Reporting timezone" data-testid="select-setting-live-reporting-tz">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HQ_TIMEZONE_OPTIONS.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value} className="text-xs">{tz.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            {STORE_LINK_FIELDS.map((field, index) => (
              <FieldRow key={field.kind} label={`${APP_STORE_LABELS[field.kind].store} link`} help={field.help} last={index === STORE_LINK_FIELDS.length - 1}>
                <StoreLinkField
                  kind={field.kind}
                  value={draft[field.key]}
                  saved={settings[field.key]}
                  testId={field.testId}
                  placeholder={field.placeholder}
                  onChange={(value) => setDraft({ [field.key]: value } as Partial<OrganizationDraft>)}
                />
              </FieldRow>
            ))}
          </>
        )}
      </PolicyCard>

      <PolicyCard
        section="coach"
        title="Coach & care team"
        sub="The patient-facing coach switch and where flagged conversations go. Offices may point escalations at their own inbox."
        settings={settings}
        fromSettings={coachFrom}
        toPayload={coachPayload}
      >
        {(draft, setDraft) => (
          <>
            <FieldRow label="Coach available to patients" help="Master switch for the in-app coach across every account. Off shows patients an honest “paused by your care team” notice and declines new chats.">
              <Switch checked={draft.coachAvailable} onCheckedChange={(checked) => setDraft({ coachAvailable: checked })} aria-label="Coach available to patients" data-testid="switch-policy-coach-available" />
            </FieldRow>
            <FieldRow label="Care-team escalation email" help="Where flagged conversations are routed unless an office sets its own destination." last>
              <input className={`${INPUT_CLASS} h-9 w-full sm:w-72`} type="email" value={draft.escalationEmail} placeholder="careteam@example.com" onChange={(e) => setDraft({ escalationEmail: e.target.value })} aria-label="Care-team escalation email" data-testid="input-policy-escalation-email" />
            </FieldRow>
          </>
        )}
      </PolicyCard>

      <PolicyCard
        section="notifications"
        title="Notification defaults"
        sub="What new patients receive until they change their own preferences, and how hard the coach may push."
        settings={settings}
        fromSettings={notificationsFrom}
        toPayload={notificationsPayload}
        incomplete={(draft) => numbersComplete([draft.outreachCooldownDays, draft.outreachDailyCap])}
      >
        {(draft, setDraft) => (
          <>
            <FieldRow label="Coach outreach on by default" help="Stall nudges and other coach-initiated messages for patients who have not chosen otherwise.">
              <Switch checked={draft.coachOutreach} onCheckedChange={(checked) => setDraft({ coachOutreach: checked })} aria-label="Coach outreach on by default" data-testid="switch-policy-default-coach-outreach" />
            </FieldRow>
            <FieldRow label="Check-in reminders on by default" help="Weekly check-in prompts for new patients.">
              <Switch checked={draft.checkInReminders} onCheckedChange={(checked) => setDraft({ checkInReminders: checked })} aria-label="Check-in reminders on by default" data-testid="switch-policy-default-check-in" />
            </FieldRow>
            <FieldRow label="Office reminders on by default" help="Appointment and office messages for new patients.">
              <Switch checked={draft.officeReminders} onCheckedChange={(checked) => setDraft({ officeReminders: checked })} aria-label="Office reminders on by default" data-testid="switch-policy-default-office" />
            </FieldRow>
            <FieldRow label="Default quiet hours" help="Nothing sends inside this window (patient's local time) unless the patient sets their own. Offices may override.">
              <QuietHoursFields idPrefix="policy-quiet" value={draft.quietHours} onChange={(quietHours) => setDraft({ quietHours })} />
            </FieldRow>
            <FieldRow label="Outreach cooldown" help="Minimum days between coach outreach messages to the same patient.">
              <NumberField id="input-policy-cooldown" label="Outreach cooldown days" value={draft.outreachCooldownDays} bounds={POLICY_BOUNDS.outreachCooldownDays} unit="days" onChange={(outreachCooldownDays) => setDraft({ outreachCooldownDays })} />
            </FieldRow>
            <FieldRow label="Daily send cap" help="Most coach outreach messages the whole program sends in one day. The sender stops at the cap and resumes tomorrow." last>
              <NumberField id="input-policy-daily-cap" label="Daily send cap" value={draft.outreachDailyCap} bounds={POLICY_BOUNDS.outreachDailyCap} unit="per day" onChange={(outreachDailyCap) => setDraft({ outreachDailyCap })} />
            </FieldRow>
          </>
        )}
      </PolicyCard>

      <PolicyCard
        section="conversations"
        title="Conversations"
        sub="How the staff inbox files quiet threads."
        settings={settings}
        fromSettings={conversationsFrom}
        toPayload={conversationsPayload}
        incomplete={(draft) => numbersComplete([draft.conversationAutoCloseDays])}
      >
        {(draft, setDraft) => (
          <FieldRow label="Auto-close after" help="A conversation with no new message for this long shows as closed in the inbox. A new message reopens it." last>
            <NumberField id="input-policy-auto-close" label="Auto-close days" value={draft.conversationAutoCloseDays} bounds={POLICY_BOUNDS.conversationAutoCloseDays} unit="days" onChange={(conversationAutoCloseDays) => setDraft({ conversationAutoCloseDays })} />
          </FieldRow>
        )}
      </PolicyCard>

      <PolicyCard
        section="security"
        title="Security"
        sub="When inactive staff sessions are signed out of the operations web app, and who must confirm a texted code at sign-in."
        settings={settings}
        fromSettings={securityFrom}
        toPayload={securityPayload}
        incomplete={(draft) => idleTimeoutProblem(draft.staffIdleTimeoutMinutes) ?? idleTimeoutProblem(draft.hqIdleTimeoutMinutes)}
      >
        {(draft, setDraft) => (
          <>
            <FieldRow label="Staff idle timeout" help="Office staff are signed out of the web app after this many minutes without activity. Offices can shorten this for their own team, never lengthen it.">
              <NumberField
                id="input-policy-staff-idle-timeout"
                label="Staff idle timeout minutes"
                value={draft.staffIdleTimeoutMinutes}
                bounds={POLICY_BOUNDS.staffIdleTimeoutMinutes}
                unit="minutes"
                problem={idleTimeoutProblem(draft.staffIdleTimeoutMinutes)}
                onChange={(staffIdleTimeoutMinutes) => setDraft({ staffIdleTimeoutMinutes })}
              />
            </FieldRow>
            <FieldRow label="HQ idle timeout" help="HQ accounts are signed out of the web app after this many minutes without activity.">
              <NumberField
                id="input-policy-hq-idle-timeout"
                label="HQ idle timeout minutes"
                value={draft.hqIdleTimeoutMinutes}
                bounds={POLICY_BOUNDS.hqIdleTimeoutMinutes}
                unit="minutes"
                problem={idleTimeoutProblem(draft.hqIdleTimeoutMinutes)}
                onChange={(hqIdleTimeoutMinutes) => setDraft({ hqIdleTimeoutMinutes })}
              />
            </FieldRow>
            <FieldRow label="Phone verification: HQ users" help="After the emailed sign-in code, every headquarters user must also confirm a texted code.">
              <Switch
                checked={draft.hqUsers}
                onCheckedChange={(hqUsers) => setDraft({ hqUsers })}
                aria-label="Require phone verification for HQ users"
                data-testid="switch-policy-second-factor-hq"
              />
            </FieldRow>
            <FieldRow label="Phone verification: office owners and admins" help="People who manage an office or its team must also confirm a texted code at sign-in.">
              <Switch
                checked={draft.officeManagers}
                onCheckedChange={(officeManagers) => setDraft({ officeManagers })}
                aria-label="Require phone verification for office owners and admins"
                data-testid="switch-policy-second-factor-managers"
              />
            </FieldRow>
            <FieldRow label="Phone verification: all staff" help="Every office teammate, including staff without team-management access, must confirm a texted code at sign-in. Anyone may also turn this on for themselves." last>
              <Switch
                checked={draft.allStaff}
                onCheckedChange={(allStaff) => setDraft({ allStaff })}
                aria-label="Require phone verification for all staff"
                data-testid="switch-policy-second-factor-all-staff"
              />
            </FieldRow>
          </>
        )}
      </PolicyCard>

      <PolicyCard
        section="retention"
        title="Data retention & exports"
        sub="How long each record class is kept, and how long a download link stays valid. Clean-up jobs read these values; they never run from this page."
        settings={settings}
        fromSettings={retentionFrom}
        toPayload={retentionPayload}
        incomplete={(draft) => numbersComplete([draft.chatTranscriptDays, draft.progressPhotoDays, draft.notificationHistoryDays, draft.auditEventDays, draft.jobRunDays, draft.signInDays, draft.webhookEventDays, draft.clinicalRecordDays, draft.exportLinkHours])}
      >
        {(draft, setDraft) => (
          <>
            <FieldRow label="Chat transcripts" help="AI coach and support conversations. Messages between patients and staff (care team) are never on this timer.">
              <NumberField id="input-policy-retention-chat" label="Chat transcript retention days" value={draft.chatTranscriptDays} bounds={POLICY_BOUNDS.chatTranscriptDays} unit="days" onChange={(chatTranscriptDays) => setDraft({ chatTranscriptDays })} />
            </FieldRow>
            <FieldRow label="Progress photos" help="Patient photo check-ins and guided photo sessions.">
              <NumberField id="input-policy-retention-photos" label="Progress photo retention days" value={draft.progressPhotoDays} bounds={POLICY_BOUNDS.progressPhotoDays} unit="days" onChange={(progressPhotoDays) => setDraft({ progressPhotoDays })} />
            </FieldRow>
            <FieldRow label="Notification history" help="Delivery records for every push notification.">
              <NumberField id="input-policy-retention-notifications" label="Notification history retention days" value={draft.notificationHistoryDays} bounds={POLICY_BOUNDS.notificationHistoryDays} unit="days" onChange={(notificationHistoryDays) => setDraft({ notificationHistoryDays })} />
            </FieldRow>
            <FieldRow label="Audit events" help="Staff and HQ audit trail. At least six years (2,190 days): HIPAA's minimum for compliance documentation. A saved value below the floor reads as the floor.">
              <NumberField id="input-policy-retention-audit" label="Audit event retention days" value={draft.auditEventDays} bounds={POLICY_BOUNDS.auditEventDays} unit="days" onChange={(auditEventDays) => setDraft({ auditEventDays })} />
            </FieldRow>
            <FieldRow label="Job run history" help="System health run ledger. The latest 50 runs of every job are always kept.">
              <NumberField id="input-policy-retention-job-runs" label="Job run history retention days" value={draft.jobRunDays} bounds={POLICY_BOUNDS.jobRunDays} unit="days" onChange={(jobRunDays) => setDraft({ jobRunDays })} />
            </FieldRow>
            <FieldRow label="Sign-in history" help="Account security sign-in ledger. Each account's latest active session is always kept; sign-in metrics cannot look back further than this.">
              <NumberField id="input-policy-retention-sign-ins" label="Sign-in history retention days" value={draft.signInDays} bounds={POLICY_BOUNDS.signInDays} unit="days" onChange={(signInDays) => setDraft({ signInDays })} />
            </FieldRow>
            <FieldRow label="Webhook events" help="Processed Stripe webhook records. Unprocessed or failed events are always kept.">
              <NumberField id="input-policy-retention-webhook-events" label="Webhook event retention days" value={draft.webhookEventDays} bounds={POLICY_BOUNDS.webhookEventDays} unit="days" onChange={(webhookEventDays) => setDraft({ webhookEventDays })} />
            </FieldRow>
            <FieldRow label="Clinical record retention" help="How long a patient's clinical record (weights, medications, labs, photos, care-team messages, orders) is kept after their account is closed or their office is offboarded. Between five and ten years; seven covers most states. Open accounts are never on this timer.">
              <NumberField id="input-policy-retention-clinical-record" label="Clinical record retention days" value={draft.clinicalRecordDays} bounds={POLICY_BOUNDS.clinicalRecordDays} unit="days" onChange={(clinicalRecordDays) => setDraft({ clinicalRecordDays })} />
            </FieldRow>
            <FieldRow label="Export link lifetime" help="How long a finished export can be downloaded before its link expires." last>
              <NumberField id="input-policy-export-hours" label="Export link lifetime hours" value={draft.exportLinkHours} bounds={POLICY_BOUNDS.exportLinkHours} unit="hours" onChange={(exportLinkHours) => setDraft({ exportLinkHours })} />
            </FieldRow>
          </>
        )}
      </PolicyCard>

      <PolicyCard
        section="archive"
        title="Cold storage archive"
        sub="A nightly copy of raw app events, audit events, orders, shipments, payments, refunds, and subscription changes into compressed files in a dedicated storage prefix. An insurance policy for the day raw rows are trimmed from the live database; nothing is ever deleted by it."
        settings={settings}
        fromSettings={archiveFrom}
        toPayload={archivePayload}
        incomplete={(draft) => (draft.coldArchiveEnabled && !settings.coldArchive.storageConfigured ? 'Cold storage is not configured on the server yet.' : null)}
      >
        {(draft, setDraft) => (
          <FieldRow
            label="Archive to cold storage"
            help="Off by default. When on, each closed day (UTC) is written once, oldest first, as one gzip file per table plus a manifest with row counts and checksums; a day only counts once every file landed. Rows are copied as stored. Clinical records are not included; they are covered by exports and record sealing."
            last
          >
            <div className="flex flex-col items-end gap-2">
              <Switch
                checked={draft.coldArchiveEnabled}
                onCheckedChange={(checked) => setDraft({ coldArchiveEnabled: checked })}
                disabled={!settings.coldArchive.storageConfigured && !draft.coldArchiveEnabled}
                aria-label="Archive to cold storage"
                data-testid="switch-policy-cold-archive"
              />
              <p className="max-w-[34ch] text-right text-[11px] leading-relaxed text-muted-foreground" data-testid="text-cold-archive-status">
                {describeArchiveStatus(settings.coldArchive, settings.coldArchiveEnabled)}
              </p>
            </div>
          </FieldRow>
        )}
      </PolicyCard>
    </>
  );
}

const idleTimeoutProblem = (value: number): string | null => {
  if (!Number.isFinite(value)) return 'Enter a timeout in minutes.';
  if (!Number.isInteger(value)) return 'Use a whole number of minutes.';
  if (value < POLICY_BOUNDS.staffIdleTimeoutMinutes.min || value > POLICY_BOUNDS.staffIdleTimeoutMinutes.max) {
    return 'Enter a value from 5 to 120 minutes.';
  }
  return null;
};

const securityPayload = (d: SecurityDraft): HqOrganizationSettingsInput => ({
  staffIdleTimeoutMinutes: d.staffIdleTimeoutMinutes,
  hqIdleTimeoutMinutes: d.hqIdleTimeoutMinutes,
  secondFactor: { hqUsers: d.hqUsers, officeManagers: d.officeManagers, allStaff: d.allStaff },
});

const securityFrom = (s: HqOrganizationSettings): SecurityDraft => ({
  staffIdleTimeoutMinutes: s.staffIdleTimeoutMinutes,
  hqIdleTimeoutMinutes: s.hqIdleTimeoutMinutes,
  hqUsers: s.secondFactor.hqUsers,
  officeManagers: s.secondFactor.officeManagers,
  allStaff: s.secondFactor.allStaff,
});

const archiveFrom = (s: HqOrganizationSettings): ArchiveDraft => ({ coldArchiveEnabled: s.coldArchiveEnabled });

/** "18 Sep 2026" for a YYYY-MM-DD archive day (UTC days; no timezone shift). */
function formatArchiveDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function describeArchiveStatus(status: HqOrganizationSettings['coldArchive'], enabled: boolean): string {
  if (!status.storageConfigured) return 'Cold storage is not configured on the server (COLD_ARCHIVE_OBJECT_DIR), so the archive cannot be turned on yet.';
  const last = status.lastArchivedDay ? `Last archived day: ${formatArchiveDay(status.lastArchivedDay)}.` : 'No day has been archived yet.';
  const pending = status.daysPending === null || status.daysPending === undefined
    ? 'Backlog unavailable right now.'
    : status.daysPending === 0
      ? 'Nothing pending.'
      : `${status.daysPending.toLocaleString('en-US')} day${status.daysPending === 1 ? '' : 's'} pending${enabled ? ' (up to 30 per nightly run)' : ''}.`;
  return `${last} ${pending}`;
}

const archivePayload = (d: ArchiveDraft): HqOrganizationSettingsInput => ({ coldArchiveEnabled: d.coldArchiveEnabled });
