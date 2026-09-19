/**
 * Office Settings — the effective organization policy as this office sees
 * it, plus the values HQ lets an office override: quiet hours, the care-team
 * escalation destination, and a shorter staff idle timeout.
 *
 * Everything else is read-only here on purpose: HQ owns the policy, and the
 * office page exists so staff can see what their patients and inbox obey
 * (and where the number came from) without asking HQ.
 *
 * Signed-in staff (and HQ drilling into an office) read the live policy from
 * the server; only roles with office-manage rights can edit, and saves ride
 * the override row's version so two managers cannot clobber each other. The
 * guided demo persona sees the seeded HQ defaults and a session-only
 * override form — nothing persists, and the copy says so.
 */
import { useMemo, useState } from 'react';
import { Copy, Loader2, RotateCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getGetOfficeSettingsQueryKey,
  useGetOfficeSettings,
  useUpdateOfficeSettingsOverrides,
  type OfficeOverrides,
  type OfficeQuietHoursOverride,
  type OfficeSettings as OfficeSettingsDto,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/contexts/session';
import { useProviderScope } from '@/contexts/provider-scope';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, CHIP_WARM, INPUT_CLASS, LINK_ACTION, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { demoOfficeSettings } from '@/data/hq/demo-office-settings';
import { Switch } from '@/components/ui/switch';
import { useOfficeAlertSettings } from '@/hooks/use-office-alerts';
import {
  OfficeApiError,
} from '@/lib/office-api';
import {
  officeAlertSettingsQueryKey,
  updateOfficeAlertPreferences,
  updateOfficeAlertSettings,
  type AlertRecipientMode,
  type OfficeAlertSettings,
} from '@/lib/office-alerts-api';
import {
  apiErrorMessage,
  apiErrorStatus,
  describeDays,
  describeHours,
  describeMinutes,
  describeOverrideStamp,
  describeQuietHours,
  describeSource,
  previewEffective,
  POLICY_BOUNDS,
  quietHoursOverrideFor,
  APP_STORE_LABELS,
  STORE_LINK_MISSING,
  storeLinksOf,
  type StoreLink,
} from '@/lib/org-policy';

// ─── Read-only policy rows ───────────────────────────────────────────────────

function PolicyRow({ label, value, help, testId, last = false }: { label: string; value: string; help?: string; testId: string; last?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5 ${last ? '' : 'border-b border-border'}`}>
      <div className="min-w-0 max-w-[46ch]">
        <p className={PANEL_LABEL}>{label}</p>
        {help && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{help}</p>}
      </div>
      <p className="text-xs font-semibold text-navy" data-testid={testId}>{value}</p>
    </div>
  );
}

/**
 * One HQ store link, echoed for copy/paste into emails and texts. The same
 * link drives the QR code on the Patients page; blank shows HQ's reminder.
 */
function StoreLinkRow({ link, last = false }: { link: StoreLink; last?: boolean }) {
  const { toast } = useToast();
  const labels = APP_STORE_LABELS[link.kind];
  const copy = async () => {
    if (!link.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast({ variant: 'success', title: `${labels.store} link copied`, description: 'Paste it into an email or text to the patient.' });
    } catch {
      toast({ variant: 'destructive', title: 'Couldn’t copy', description: 'Select the link text and copy it manually.' });
    }
  };
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5 ${last ? '' : 'border-b border-border'}`}>
      <div className="min-w-0 max-w-[46ch]">
        <p className={PANEL_LABEL}>{labels.store} link</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{labels.device}. Set by HQ; the QR code on your Patients page points here.</p>
      </div>
      {link.url ? (
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 max-w-[34ch] truncate text-xs font-semibold text-primary underline-offset-2 hover:underline"
            data-testid={`policy-store-link-${link.kind}`}
          >
            {link.url}
          </a>
          <button
            type="button"
            className={`${BTN_SECONDARY} h-7 px-2 text-[11px]`}
            onClick={() => void copy()}
            aria-label={`Copy ${labels.store} link`}
            data-testid={`button-copy-store-link-${link.kind}`}
          >
            <Copy size={12} aria-hidden="true" className="mr-1" />
            Copy
          </button>
        </div>
      ) : (
        <p className="text-xs font-semibold text-[#b65c22]" data-testid={`policy-store-link-${link.kind}`}>{STORE_LINK_MISSING}</p>
      )}
    </div>
  );
}
function EffectiveChip({ source }: { source: 'office' | 'hq' }) {
  return <span className={source === 'office' ? CHIP_WARM : CHIP_COBALT}>{describeSource(source)}</span>;
}

const TIME_ZONES = [
  ['America/New_York', 'Eastern (ET)'],
  ['America/Chicago', 'Central (CT)'],
  ['America/Denver', 'Mountain (MT)'],
  ['America/Los_Angeles', 'Pacific (PT)'],
  ['UTC', 'UTC'],
] as const;

const DEMO_ALERT_SETTINGS: OfficeAlertSettings = {
  recipientMode: 'all',
  recipientMemberIds: [],
  sendTime: '08:00',
  timeZone: 'America/Los_Angeles',
  timeZoneSource: 'hq',
  version: 1,
  canEdit: true,
  me: { emailEnabled: true, pushEnabled: true, email: 'sarah@demo.example' },
  team: [
    { id: 'owner', name: 'Dr. Sarah Jenkins', role: 'owner', status: 'active' },
    { id: 'demo-admin', name: 'Alex Morgan', role: 'admin', status: 'active' },
    { id: 'demo-staff', name: 'Jamie Lee', role: 'staff', status: 'active' },
  ],
};

export interface AlertDraft {
  recipientMode: AlertRecipientMode;
  recipientMemberIds: string[];
  sendTime: string;
  timeZone: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
}

const alertDraftFrom = (data: OfficeAlertSettings): AlertDraft => ({
  recipientMode: data.recipientMode,
  recipientMemberIds: data.recipientMemberIds,
  sendTime: data.sendTime,
  timeZone: data.timeZoneSource === 'hq' ? '' : data.timeZone,
  emailEnabled: data.me.emailEnabled,
  pushEnabled: data.me.pushEnabled,
});

export function PatientAlertsCard({ data, demo, preferenceReadOnly, saving, onSave, onPreference }: {
  data: OfficeAlertSettings;
  demo: boolean;
  preferenceReadOnly: boolean;
  saving: boolean;
  onSave: (draft: AlertDraft) => void;
  onPreference: (field: 'emailEnabled' | 'pushEnabled', value: boolean) => void;
}) {
  const saved = useMemo(() => alertDraftFrom(data), [data]);
  const [draft, setDraft] = useState(saved);
  const [snapshot, setSnapshot] = useState(saved);
  if (snapshot !== saved) {
    setSnapshot(saved);
    setDraft(saved);
  }
  const canEdit = data.canEdit;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const modes: Array<{ value: AlertRecipientMode; label: string }> = [
    { value: 'all', label: 'Everyone on the team' },
    { value: 'owners_admins', label: 'Owners and admins' },
    { value: 'selected', label: 'Specific teammates' },
  ];
  const toggleMember = (id: string, checked: boolean) => setDraft((current) => ({
    ...current,
    recipientMemberIds: checked
      ? [...new Set([...current.recipientMemberIds, id])]
      : current.recipientMemberIds.filter((value) => value !== id),
  }));

  return (
    <>
      <SectionCard
        title="Patient alerts"
        sub={demo ? 'Choose who receives the daily demo digest. Changes last for this session.' : 'Choose who receives the daily attention digest and when it is sent.'}
        action={canEdit ? <button type="button" className={`${BTN_PRIMARY} h-8 px-3 disabled:opacity-50`} disabled={!dirty || saving} onClick={() => onSave(draft)} data-testid="button-save-alert-settings">{saving ? 'Saving…' : 'Save'}</button> : <span className="text-[11px] text-muted-foreground" data-testid="alert-settings-read-only">Read-only for your role</span>}
      >
        <div className="space-y-5 px-5 py-4">
          <fieldset disabled={!canEdit}>
            <legend className={PANEL_LABEL}>Recipients</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {modes.map((mode) => <label key={mode.value} className={`flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs ${draft.recipientMode === mode.value ? 'border-primary bg-accent text-navy' : 'border-border'}`}><input type="radio" name="alert-recipient-mode" value={mode.value} checked={draft.recipientMode === mode.value} onChange={() => setDraft({ ...draft, recipientMode: mode.value })} data-testid={`radio-alert-${mode.value}`} />{mode.label}</label>)}
            </div>
          </fieldset>
          {draft.recipientMode === 'selected' && (
            <fieldset disabled={!canEdit}>
              <legend className={PANEL_LABEL}>Selected teammates</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {data.team.map((member) => <label key={member.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"><input type="checkbox" checked={draft.recipientMemberIds.includes(member.id)} onChange={(event) => toggleMember(member.id, event.target.checked)} data-testid={`checkbox-alert-member-${member.id}`} /><span><b className="text-navy">{member.name}</b> <span className="text-muted-foreground">· {member.role}</span></span></label>)}
              </div>
            </fieldset>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label><span className={PANEL_LABEL}>Daily send time</span><input type="time" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.sendTime} onChange={(event) => setDraft({ ...draft, sendTime: event.target.value })} disabled={!canEdit} data-testid="input-alert-send-time" /></label>
            <label><span className={PANEL_LABEL}>Time zone</span><select className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} disabled={!canEdit} data-testid="select-alert-time-zone"><option value="">Follow HQ ({data.timeZone})</option>{draft.timeZone && !TIME_ZONES.some(([value]) => value === draft.timeZone) && <option value={draft.timeZone}>{draft.timeZone}</option>}{TIME_ZONES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span className="mt-1 block text-[10px] text-muted-foreground">{data.timeZoneSource === 'hq' ? 'Currently inherited from HQ' : 'Set by this office'}</span></label>
          </div>
        </div>
      </SectionCard>
      <SectionCard title="My alert delivery" sub={data.me.email ? `Daily digest delivery for ${data.me.email}. The portal bell is always on.` : 'Your daily digest channels. The portal bell is always on.'}>
        <div className="divide-y divide-border">
          {([
            ['emailEnabled', 'Email digest'],
            ['pushEnabled', 'Mobile push'],
          ] as const).map(([field, label]) => <label key={field} className="flex items-center justify-between gap-4 px-5 py-4"><span className="text-xs font-semibold text-navy">{label}</span><Switch checked={draft[field]} disabled={preferenceReadOnly || saving} onCheckedChange={(value) => { setDraft((current) => ({ ...current, [field]: value })); onPreference(field, value); }} aria-label={label} data-testid={`switch-alert-${field}`} /></label>)}
        </div>
      </SectionCard>
    </>
  );
}

// ─── Override form ───────────────────────────────────────────────────────────

interface OverrideDraft {
  quietHours: OfficeQuietHoursOverride;
  escalationEmail: string;
  idleTimeoutMinutes: number | null;
}

const draftFrom = (overrides: OfficeOverrides): OverrideDraft => ({
  quietHours: overrides.quietHours.mode === 'custom'
    ? { mode: 'custom', start: overrides.quietHours.start, end: overrides.quietHours.end }
    : { mode: overrides.quietHours.mode },
  escalationEmail: overrides.escalationEmail ?? '',
  idleTimeoutMinutes: overrides.idleTimeoutMinutes,
});

function OverridesCard({ data, live, onSave, saving, saveError }: {
  data: OfficeSettingsDto;
  live: boolean;
  saving: boolean;
  saveError: unknown;
  onSave: (draft: OverrideDraft, expectedVersion: number) => void;
}) {
  const { toast } = useToast();
  const saved = useMemo(() => draftFrom(data.overrides), [data.overrides]);
  const [draft, setDraft] = useState<OverrideDraft>(saved);
  const [snapshot, setSnapshot] = useState(saved);
  if (snapshot !== saved) {
    setSnapshot(saved);
    setDraft(saved);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const preview = previewEffective(data.hq, {
    quietHours: draft.quietHours,
    escalationEmail: draft.escalationEmail || null,
    idleTimeoutMinutes: draft.idleTimeoutMinutes,
  });
  const canEdit = data.canEdit;
  const stamp = describeOverrideStamp(data.overrides.updatedAt, data.overrides.updatedByName);
  const idleTimeoutProblem = draft.idleTimeoutMinutes !== null && (
    !Number.isInteger(draft.idleTimeoutMinutes)
      ? 'Use a whole number of minutes.'
      : draft.idleTimeoutMinutes < POLICY_BOUNDS.staffIdleTimeoutMinutes.min
        ? 'Enter at least 5 minutes.'
        : draft.idleTimeoutMinutes > data.hq.staffIdleTimeoutMinutes
          ? `This office’s timeout cannot exceed HQ’s ${data.hq.staffIdleTimeoutMinutes}-minute setting.`
          : null
  );
  const errorData = (saveError as { data?: { field?: unknown; error?: unknown } } | null)?.data;
  const idleTimeoutServerProblem = apiErrorStatus(saveError) === 400 &&
    errorData?.field === 'idleTimeoutMinutes' &&
    typeof errorData.error === 'string'
    ? errorData.error
    : null;
  const shownIdleTimeoutProblem = idleTimeoutProblem ?? idleTimeoutServerProblem;

  const setMode = (mode: OfficeQuietHoursOverride['mode']) =>
    setDraft((current) => ({ ...current, quietHours: quietHoursOverrideFor(mode, current.quietHours, data.hq.defaultQuietHours) }));

  const modes: Array<{ value: OfficeQuietHoursOverride['mode']; label: string; help: string }> = [
    { value: 'inherit', label: 'Follow HQ', help: `HQ default: ${describeQuietHours(data.hq.defaultQuietHours)}` },
    { value: 'none', label: 'No quiet hours', help: 'This office sends at any hour a patient allows.' },
    { value: 'custom', label: 'Office window', help: 'A start and end time in each patient’s local time.' },
  ];

  return (
    <SectionCard
      title="Office overrides"
      sub={
        <>
          Values HQ lets an office set for itself. Blank or “Follow HQ” means the HQ default applies.
          {stamp && <span className="mt-1 block text-[11px] text-muted-foreground/80" data-testid="override-stamp">{stamp}</span>}
          {!live && <span className="mt-1 block text-[11px] text-muted-foreground/80">Demo session only — nothing is saved.</span>}
        </>
      }
      action={
        canEdit ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={`${LINK_ACTION} inline-flex items-center gap-1`}
              onClick={() => { setDraft(saved); toast({ variant: 'success', title: 'Draft discarded', description: 'Back to the saved overrides.' }); }}
              aria-label="Discard override changes"
              disabled={!dirty || saving}
            >
              <RotateCcw size={12} aria-hidden="true" />
              Reset
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-8 px-3 disabled:cursor-not-allowed disabled:opacity-50`}
              disabled={!dirty || saving}
              data-testid="button-save-office-overrides"
              onClick={() => {
                if (!idleTimeoutProblem) onSave(draft, data.overrides.version);
              }}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Saving" /> : 'Save'}
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground" data-testid="override-read-only">Read-only for your role</span>
        )
      }
    >
      <div>
        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0 max-w-[46ch]">
              <p className={PANEL_LABEL}>Quiet hours</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                No notification sends inside this window unless the patient set their own quiet hours.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <EffectiveChip source={preview.source.quietHours} />
              <span className="text-xs font-semibold text-navy" data-testid="effective-quiet-hours">{describeQuietHours(preview.quietHours)}</span>
            </div>
          </div>
          <fieldset className="mt-3 grid gap-2 sm:grid-cols-3" disabled={!canEdit}>
            <legend className="sr-only">Quiet hours source</legend>
            {modes.map((mode) => {
              const selected = draft.quietHours.mode === mode.value;
              return (
                <label
                  key={mode.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2.5 text-xs transition ${selected ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-accent/40'} ${canEdit ? '' : 'cursor-default opacity-80'}`}
                >
                  <input
                    type="radio"
                    name="quiet-hours-mode"
                    className="mt-0.5"
                    value={mode.value}
                    checked={selected}
                    onChange={() => setMode(mode.value)}
                    data-testid={`radio-quiet-${mode.value}`}
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold text-navy">{mode.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{mode.help}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {draft.quietHours.mode === 'custom' && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="time"
                className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
                value={draft.quietHours.start ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, quietHours: { mode: 'custom', start: event.target.value, end: current.quietHours.end } }))}
                aria-label="Office quiet hours start"
                data-testid="input-override-quiet-start"
                disabled={!canEdit}
              />
              <span>to</span>
              <input
                type="time"
                className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
                value={draft.quietHours.end ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, quietHours: { mode: 'custom', start: current.quietHours.start, end: event.target.value } }))}
                aria-label="Office quiet hours end"
                data-testid="input-override-quiet-end"
                disabled={!canEdit}
              />
            </div>
          )}
        </div>

        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0 max-w-[46ch]">
              <p className={PANEL_LABEL}>Idle timeout</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Sign this office’s staff out sooner after inactivity, or use HQ’s setting.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <EffectiveChip source={preview.source.idleTimeoutMinutes} />
              <span className="text-xs font-semibold text-navy" data-testid="effective-idle-timeout">{describeMinutes(preview.idleTimeoutMinutes)}</span>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-border px-3 py-2">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">HQ default</span>
              <span className="mt-1 block text-xs font-semibold text-navy" data-testid="idle-timeout-hq-default">{describeMinutes(data.hq.staffIdleTimeoutMinutes)}</span>
            </div>
            <div className="rounded-md border border-border px-3 py-2">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Office override</span>
              <span className="mt-1 block text-xs font-semibold text-navy" data-testid="idle-timeout-office-override">
                {data.overrides.idleTimeoutMinutes === null ? 'None' : describeMinutes(data.overrides.idleTimeoutMinutes)}
              </span>
            </div>
            <div className="rounded-md border border-border px-3 py-2">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Effective</span>
              <span className="mt-1 block text-xs font-semibold text-navy">{describeMinutes(preview.idleTimeoutMinutes)} · {describeSource(preview.source.idleTimeoutMinutes)}</span>
            </div>
          </div>
          <fieldset className="mt-3 grid gap-2 sm:grid-cols-2" disabled={!canEdit}>
            <legend className="sr-only">Idle timeout source</legend>
            <label className={`flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs ${draft.idleTimeoutMinutes === null ? 'border-primary bg-accent' : 'border-border'}`}>
              <input
                type="radio"
                name="idle-timeout-mode"
                checked={draft.idleTimeoutMinutes === null}
                onChange={() => setDraft((current) => ({ ...current, idleTimeoutMinutes: null }))}
                data-testid="radio-idle-inherit"
                disabled={!canEdit}
              />
              <span className="font-semibold text-navy">Use HQ’s setting ({data.hq.staffIdleTimeoutMinutes} minutes)</span>
            </label>
            <label className={`flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs ${draft.idleTimeoutMinutes !== null ? 'border-primary bg-accent' : 'border-border'}`}>
              <input
                type="radio"
                name="idle-timeout-mode"
                checked={draft.idleTimeoutMinutes !== null}
                onChange={() => setDraft((current) => ({
                  ...current,
                  idleTimeoutMinutes: Math.max(POLICY_BOUNDS.staffIdleTimeoutMinutes.min, data.hq.staffIdleTimeoutMinutes - 5),
                }))}
                data-testid="radio-idle-shorter"
                disabled={!canEdit}
              />
              <span className="font-semibold text-navy">Shorter for this office</span>
            </label>
          </fieldset>
          {draft.idleTimeoutMinutes !== null && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={POLICY_BOUNDS.staffIdleTimeoutMinutes.min}
                  max={data.hq.staffIdleTimeoutMinutes}
                  step={1}
                  className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
                  value={Number.isFinite(draft.idleTimeoutMinutes) ? draft.idleTimeoutMinutes : ''}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    idleTimeoutMinutes: event.target.value === '' ? Number.NaN : Number(event.target.value),
                  }))}
                  aria-label="Office idle timeout minutes"
                  aria-invalid={shownIdleTimeoutProblem ? true : undefined}
                  data-testid="input-override-idle-timeout"
                  disabled={!canEdit}
                />
                <span className="text-[11px] text-muted-foreground">minutes · 5–{data.hq.staffIdleTimeoutMinutes}</span>
              </div>
              {shownIdleTimeoutProblem && (
                <p className="mt-1 text-[11px] font-medium text-destructive" role="alert" data-testid="idle-timeout-error">
                  {shownIdleTimeoutProblem}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0 max-w-[46ch]">
              <p className={PANEL_LABEL}>Care-team escalation email</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Where flagged conversations for this office are routed. HQ default: {data.hq.escalationEmail ?? 'not set'}.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <EffectiveChip source={preview.source.escalationEmail} />
              <span className="text-xs font-semibold text-navy" data-testid="effective-escalation-email">{preview.escalationEmail ?? 'Not set'}</span>
            </div>
          </div>
          <input
            type="email"
            className={`${INPUT_CLASS} mt-3 h-9 w-full sm:w-80`}
            value={draft.escalationEmail}
            placeholder={data.hq.escalationEmail ? `Leave blank to use ${data.hq.escalationEmail}` : 'Leave blank to follow HQ'}
            onChange={(event) => setDraft((current) => ({ ...current, escalationEmail: event.target.value }))}
            aria-label="Office escalation email"
            data-testid="input-override-escalation-email"
            disabled={!canEdit}
          />
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OfficeSettings() {
  const { authStatus, authRole, authUser } = useSession();
  const scope = useProviderScope();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const live =
    authStatus === 'signed-in' &&
    (authRole === 'provider_staff' || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
  const officeParam = authRole === 'hq_admin' ? scope?.providerId : undefined;
  const params = officeParam ? { office: officeParam } : undefined;
  const signedIn = authStatus === 'signed-in';

  const query = useGetOfficeSettings(params, {
    query: { enabled: live, queryKey: [...getGetOfficeSettingsQueryKey(params), authUser?.id] },
  });
  const update = useUpdateOfficeSettingsOverrides();
  const alertQuery = useOfficeAlertSettings();
  const [demoAlerts, setDemoAlerts] = useState<OfficeAlertSettings>(DEMO_ALERT_SETTINGS);
  const alertData = live ? alertQuery.data : signedIn ? undefined : demoAlerts;
  const alertSettingsMutation = useMutation({
    mutationFn: ({ draft, expectedVersion }: { draft: AlertDraft; expectedVersion: number }) => updateOfficeAlertSettings({
      expectedVersion,
      recipientMode: draft.recipientMode,
      recipientMemberIds: draft.recipientMemberIds,
      sendTime: draft.sendTime,
      timeZone: draft.timeZone || null,
    }, officeParam),
    onSuccess: (result) => {
      queryClient.setQueryData(officeAlertSettingsQueryKey(officeParam), result);
      void queryClient.invalidateQueries({ queryKey: officeAlertSettingsQueryKey(officeParam) });
      toast({ variant: 'success', title: 'Patient alerts saved', description: 'The next daily digest will use these recipients and delivery time.' });
    },
    onError: (error) => {
      if (error instanceof OfficeApiError && error.isConflict) {
        void queryClient.invalidateQueries({ queryKey: officeAlertSettingsQueryKey(officeParam) });
        toast({ variant: 'destructive', title: 'Someone else saved first', description: 'The alert settings changed while you were editing. The latest values have been reloaded.' });
      } else {
        toast({ variant: 'destructive', title: 'Patient alerts not saved', description: error instanceof Error ? error.message : 'Please try again.' });
      }
    },
  });
  const preferenceMutation = useMutation({
    mutationFn: (body: { emailEnabled: boolean; pushEnabled: boolean }) => updateOfficeAlertPreferences(body, officeParam),
    onSuccess: (result) => {
      if (alertData) {
        const next = { ...alertData, me: { ...alertData.me, ...result } };
        if (live) queryClient.setQueriesData({ queryKey: officeAlertSettingsQueryKey(officeParam) }, next);
        else setDemoAlerts(next);
      }
      toast({ variant: 'success', title: 'Alert delivery updated', description: 'Your personal delivery choices are saved.' });
    },
    onError: (error) => toast({ variant: 'destructive', title: 'Delivery choice not saved', description: error instanceof Error ? error.message : 'Please try again.' }),
  });

  // Demo persona: seeded HQ defaults + a session-held override row.
  const [demo, setDemo] = useState<OfficeSettingsDto>(demoOfficeSettings);

  // Signed-in users never see demo data: HQ staff who reach the office shell
  // without drilling into an office get an honest pointer instead.
  const data = live ? query.data : signedIn ? undefined : demo;

  const save = (draft: OverrideDraft, expectedVersion: number) => {
    const body = {
      expectedVersion,
      quietHours: draft.quietHours,
      escalationEmail: draft.escalationEmail.trim() || null,
      idleTimeoutMinutes: draft.idleTimeoutMinutes,
    };
    if (!live) {
      const overrides: OfficeOverrides = {
        ...demo.overrides,
        quietHours: body.quietHours,
        escalationEmail: body.escalationEmail,
        idleTimeoutMinutes: body.idleTimeoutMinutes,
        version: demo.overrides.version + 1,
        updatedAt: new Date().toISOString(),
        updatedByName: 'You',
      };
      setDemo({ ...demo, overrides, effective: previewEffective(demo.hq, overrides) });
      toast({ variant: 'success', title: 'Office overrides saved', description: 'Applied to this demo session — nothing real is configured.' });
      return;
    }
    update.mutate(
      { params, data: body },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetOfficeSettingsQueryKey(params) });
          toast({ variant: 'success', title: 'Office overrides saved', description: 'Your patients’ notifications and escalations follow the new values from now on.' });
        },
        onError: (error) => {
          if (apiErrorStatus(error) === 409) {
            void queryClient.invalidateQueries({ queryKey: getGetOfficeSettingsQueryKey(params) });
            toast({ variant: 'destructive', title: 'Someone else saved first', description: 'The overrides changed while you were editing. The latest values have been reloaded.' });
            return;
          }
          toast({ variant: 'destructive', title: 'Overrides not saved', description: apiErrorMessage(error, 'Could not save the office overrides. Please try again.') });
        },
      },
    );
  };

  const saveAlerts = (draft: AlertDraft) => {
    if (!live) {
      setDemoAlerts((current) => ({
        ...current,
        recipientMode: draft.recipientMode,
        recipientMemberIds: draft.recipientMemberIds,
        sendTime: draft.sendTime,
        timeZone: draft.timeZone || current.timeZone,
        timeZoneSource: draft.timeZone ? 'office' : 'hq',
        version: current.version + 1,
      }));
      toast({ variant: 'success', title: 'Patient alerts saved', description: 'Applied to this demo session only.' });
      return;
    }
    if (alertData) alertSettingsMutation.mutate({ draft, expectedVersion: alertData.version });
  };

  const savePreference = (field: 'emailEnabled' | 'pushEnabled', value: boolean) => {
    if (!alertData) return;
    const body = { emailEnabled: field === 'emailEnabled' ? value : alertData.me.emailEnabled, pushEnabled: field === 'pushEnabled' ? value : alertData.me.pushEnabled };
    if (!live) {
      setDemoAlerts((current) => ({ ...current, me: { ...current.me, ...body } }));
      return;
    }
    preferenceMutation.mutate(body);
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6">
        <h1 className="font-serif text-[32px] leading-none tracking-[-.02em] text-navy">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The organization policy your patients, notifications, and inbox follow{data ? ` — ${data.office.officeName}` : ''}.
        </p>
      </div>

      {signedIn && !live && (
        <div className="rounded-lg border border-card-border bg-card px-5 py-8 text-center text-sm text-muted-foreground shadow-soft" data-testid="office-settings-unscoped">
          Open an office from HQ to see the policy it follows and its overrides.
        </div>
      )}
      {live && query.isLoading && (
        <div className="flex items-center justify-center rounded-lg border border-card-border bg-card p-10 shadow-soft" role="status" aria-label="Loading settings">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {live && query.isError && (
        <div className="rounded-lg border border-card-border bg-card px-5 py-8 text-center text-sm text-destructive shadow-soft" role="alert" data-testid="office-settings-error">
          {apiErrorStatus(query.error) === 423
            ? 'This office account is locked. Settings are unavailable until HQ unlocks it.'
            : 'Could not load the organization policy. Refresh to try again.'}
        </div>
      )}

      {data && (
        <div className="space-y-5">
          {alertData && <PatientAlertsCard data={alertData} demo={!live} preferenceReadOnly={Boolean(officeParam)} saving={alertSettingsMutation.isPending || preferenceMutation.isPending} onSave={saveAlerts} onPreference={savePreference} />}
          {live && alertQuery.isPending && <div role="status" className="rounded-lg border border-border bg-card px-5 py-8 text-xs text-muted-foreground">Loading patient alert settings…</div>}
          {live && alertQuery.isError && <div role="alert" aria-live="polite" className="rounded-lg border border-[#d5a7a7] bg-[#fff0f0] px-5 py-5 text-xs text-destructive">Patient alert settings could not be loaded.</div>}
           <OverridesCard data={data} live={live} saving={update.isPending} saveError={update.error} onSave={save} />

          <SectionCard title="Coach & care team" sub="Set by HQ for every office.">
            <PolicyRow
              label="Coach available to patients"
              value={data.hq.coachAvailable ? 'On' : 'Paused by HQ'}
              help={data.hq.coachAvailable ? 'Patients can chat with the coach.' : 'Patients see a “paused by your care team” notice instead of the coach.'}
              testId="policy-coach-available"
              last
            />
          </SectionCard>

          <SectionCard title="Get the app" sub="The store listings behind the QR codes on your Patients page. Copy a link to send it by email or text.">
            {storeLinksOf(data.hq).map((link, index, all) => (
              <StoreLinkRow key={link.kind} link={link} last={index === all.length - 1} />
            ))}
          </SectionCard>

          <SectionCard title="Notification defaults" sub="What new patients receive until they change their own preferences, and how hard the coach may push.">
            <PolicyRow label="Coach outreach" value={data.hq.defaultCategories.coachOutreach ? 'On by default' : 'Off by default'} testId="policy-default-coach-outreach" />
            <PolicyRow label="Check-in reminders" value={data.hq.defaultCategories.checkInReminders ? 'On by default' : 'Off by default'} testId="policy-default-check-in" />
            <PolicyRow label="Office reminders" value={data.hq.defaultCategories.officeReminders ? 'On by default' : 'Off by default'} testId="policy-default-office" />
            <PolicyRow label="HQ default quiet hours" value={describeQuietHours(data.hq.defaultQuietHours)} help="Your office's effective window is shown above." testId="policy-hq-quiet-hours" />
            <PolicyRow label="Outreach cooldown" value={describeDays(data.hq.outreachCooldownDays)} help="Minimum gap between coach outreach messages to one patient." testId="policy-cooldown" />
            <PolicyRow label="Daily send cap" value={`${data.hq.outreachDailyCap} per day`} help="Program-wide ceiling on coach outreach per day." testId="policy-daily-cap" last />
          </SectionCard>

          <SectionCard title="Conversations" sub="How the inbox files quiet threads.">
            <PolicyRow label="Auto-close after" value={describeDays(data.hq.conversationAutoCloseDays)} help="A thread with no new message for this long shows as closed. A new message reopens it." testId="policy-auto-close" last />
          </SectionCard>

          <SectionCard title="Data retention & exports" sub="How long each record class is kept, and how long a download link stays valid.">
            <PolicyRow label="Chat transcripts" value={describeDays(data.hq.retention.chatTranscriptDays)} help="AI coach and support conversations only. Your messages with patients are never on this timer." testId="policy-retention-chat" />
            <PolicyRow label="Progress photos" value={describeDays(data.hq.retention.progressPhotoDays)} testId="policy-retention-photos" />
            <PolicyRow label="Notification history" value={describeDays(data.hq.retention.notificationHistoryDays)} testId="policy-retention-notifications" />
            <PolicyRow label="Audit events" value={describeDays(data.hq.retention.auditEventDays)} help="Never less than six years." testId="policy-retention-audit" />
            <PolicyRow label="Job run history" value={describeDays(data.hq.retention.jobRunDays)} testId="policy-retention-job-runs" />
            <PolicyRow label="Sign-in history" value={describeDays(data.hq.retention.signInDays)} testId="policy-retention-sign-ins" />
            <PolicyRow label="Webhook events" value={describeDays(data.hq.retention.webhookEventDays)} testId="policy-retention-webhook-events" />
            <PolicyRow label="Clinical record retention" value={describeDays(data.hq.retention.clinicalRecordDays)} help="How long a patient's clinical record is kept after their account is closed or an office is offboarded. Open accounts are never on this timer." testId="policy-retention-clinical-record" />
            <PolicyRow label="Export link lifetime" value={describeHours(data.hq.exportLinkHours)} testId="policy-export-hours" last />
          </SectionCard>
        </div>
      )}
    </div>
  );
}
