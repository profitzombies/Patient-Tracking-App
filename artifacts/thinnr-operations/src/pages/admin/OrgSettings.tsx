/**
 * Org-level settings for the THINNR program.
 *
 * Values load from the session HQ store and edit as per-group drafts: Save
 * commits the group's fields (persisting them for this demo session), Reset
 * returns the drafts to the shipped defaults. Nothing configures any real
 * system — the page demos the workflow, and the copy says so.
 */
import { useState, useSyncExternalStore, useEffect, useMemo } from 'react';
import { RotateCcw, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { isToastSoundEnabled, setToastSoundEnabled, subscribeToastSound } from '@/lib/toast-sound';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BTN_PRIMARY, INPUT_CLASS, LINK_ACTION, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { HQ_SETTINGS_GROUPS, type HqSettingValue, type HqSettingsGroup } from '@/data/hq/settings';
import { useSession } from '@/contexts/session';
import { useGetHqSettings, getGetHqSettingsQueryKey, useUpdateHqSettings, type HqOrganizationSettingsInput } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

function LiveOrgSettingsCard() {
  const { authStatus, hqRole, authUser } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isLive = authStatus === 'signed-in';
  const canEdit = isLive && (hqRole === 'Admin' || hqRole === 'Super Admin');

  const { data: settings, isLoading, isError } = useGetHqSettings({
    query: {
      enabled: isLive && canEdit,
      queryKey: [...getGetHqSettingsQueryKey(), authUser?.id]
    }
  });

  const updateSettings = useUpdateHqSettings();

  const [drafts, setDrafts] = useState<HqOrganizationSettingsInput | null>(null);

  useEffect(() => {
    if (settings) {
      setDrafts({
        organizationName: settings.organizationName,
        supportEmail: settings.supportEmail,
        supportPhone: settings.supportPhone,
        defaultTimezone: settings.defaultTimezone,
      });
    }
  }, [settings]);

  const dirty = useMemo(() => {
    if (!settings || !drafts) return false;
    return drafts.organizationName !== settings.organizationName ||
           drafts.supportEmail !== settings.supportEmail ||
           drafts.supportPhone !== settings.supportPhone ||
           drafts.defaultTimezone !== settings.defaultTimezone;
  }, [settings, drafts]);

  const setDraft = (key: keyof HqOrganizationSettingsInput, value: string | null) => {
    if (drafts) {
      setDrafts({ ...drafts, [key]: value });
    }
  };

  const save = () => {
    if (!drafts) return;
    updateSettings.mutate({ data: drafts }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetHqSettingsQueryKey() });
        toast({ variant: 'success', title: 'Organization profile saved', description: 'Changes have been applied live.' });
      },
      onError: () => {
        toast({ variant: 'destructive', title: 'Failed to save settings', description: 'Could not apply changes. Please try again.' });
      }
    });
  };

  const reset = () => {
    if (settings) {
      setDrafts({
        organizationName: settings.organizationName,
        supportEmail: settings.supportEmail,
        supportPhone: settings.supportPhone,
        defaultTimezone: settings.defaultTimezone,
      });
      toast({ variant: 'success', title: 'Live settings restored', description: 'Reverted to the currently saved live settings.' });
    }
  };

  if (!isLive) return null; // We render the mock ones in demo mode

  if (!canEdit) {
    return (
      <SectionCard title="Organization profile" sub="How THINNR appears across HQ tools and provider-facing emails.">
        <div className="px-5 py-8 text-center text-sm text-muted-foreground">
          You need Admin or Super Admin access to view or change these settings.
        </div>
      </SectionCard>
    );
  }

  if (isLoading) {
    return (
      <SectionCard title="Organization profile" sub="Loading live settings...">
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </SectionCard>
    );
  }

  if (isError || !drafts) {
    return (
      <SectionCard title="Organization profile" sub="How THINNR appears across HQ tools and provider-facing emails.">
        <div className="px-5 py-8 text-center text-sm text-destructive">
          Failed to load organization settings. Please refresh the page.
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Organization profile"
      sub="How THINNR appears across HQ tools and provider-facing emails."
      action={
        <div className="flex items-center gap-3">
          <button type="button" className={`${LINK_ACTION} inline-flex items-center gap-1`} onClick={reset} aria-label="Reset live settings" disabled={updateSettings.isPending}>
            <RotateCcw size={12} aria-hidden="true" />
            Reset
          </button>
          <button
            type="button"
            className={`${BTN_PRIMARY} h-8 px-3 disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={!dirty || updateSettings.isPending}
            data-testid="button-save-live-organization"
            onClick={save}
          >
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </button>
        </div>
      }
    >
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-5 py-4">
          <div className="min-w-0 max-w-[46ch]">
            <p className={PANEL_LABEL}>Organization name</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Shown in report headers and provider onboarding material.</p>
          </div>
          <div className="shrink-0">
            <input
              className={`${INPUT_CLASS} h-9 w-full sm:w-72`}
              value={drafts.organizationName}
              placeholder="THINNR, Inc."
              onChange={(e) => setDraft('organizationName', e.target.value)}
              aria-label="Organization name"
              data-testid="input-setting-live-org-name"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-5 py-4">
          <div className="min-w-0 max-w-[46ch]">
            <p className={PANEL_LABEL}>Support email</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Where provider offices reach HQ.</p>
          </div>
          <div className="shrink-0">
            <input
              className={`${INPUT_CLASS} h-9 w-full sm:w-72`}
              value={drafts.supportEmail ?? ''}
              placeholder="support@thinnr.example.com"
              onChange={(e) => setDraft('supportEmail', e.target.value || null)}
              aria-label="Support email"
              data-testid="input-setting-live-support-email"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-5 py-4">
          <div className="min-w-0 max-w-[46ch]">
            <p className={PANEL_LABEL}>Support phone</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Optional contact number for provider support.</p>
          </div>
          <div className="shrink-0">
            <input
              className={`${INPUT_CLASS} h-9 w-full sm:w-72`}
              value={drafts.supportPhone ?? ''}
              placeholder="(800) 555-0199"
              onChange={(e) => setDraft('supportPhone', e.target.value || null)}
              aria-label="Support phone"
              data-testid="input-setting-live-support-phone"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-5 py-4">
          <div className="min-w-0 max-w-[46ch]">
            <p className={PANEL_LABEL}>Reporting timezone</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Display label for live rollup reports.</p>
          </div>
          <div className="shrink-0">
            <Select value={drafts.defaultTimezone} onValueChange={(val) => setDraft('defaultTimezone', val)}>
              <SelectTrigger className="h-9 w-full text-xs sm:w-72" aria-label="Reporting timezone" data-testid="select-setting-live-reporting-tz">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  { value: 'America/New_York', label: 'Eastern (ET)' },
                  { value: 'America/Chicago', label: 'Central (CT)' },
                  { value: 'America/Denver', label: 'Mountain (MT)' },
                  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
                  { value: 'UTC', label: 'UTC' }
                ].map((tz) => (
                  <SelectItem key={tz.value} value={tz.value} className="text-xs">{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function GroupCard({ group }: { group: HqSettingsGroup }) {
  const { settingsValues, saveSettings } = useHqData();
  const { toast } = useToast();

  // Drafts start from the saved session values; Save is enabled only when a
  // field genuinely differs, so the demo reads like a real settings surface.
  const [drafts, setDrafts] = useState<Record<string, HqSettingValue>>(() => {
    const initial: Record<string, HqSettingValue> = {};
    for (const field of group.fields) {
      const key = `${group.id}.${field.id}`;
      initial[key] = settingsValues[key] ?? field.defaultValue;
    }
    return initial;
  });

  const dirty = group.fields.some((field) => {
    const key = `${group.id}.${field.id}`;
    return drafts[key] !== (settingsValues[key] ?? field.defaultValue);
  });

  const setDraft = (key: string, value: HqSettingValue) => setDrafts((current) => ({ ...current, [key]: value }));

  const save = () => {
    saveSettings(drafts);
    toast({ variant: 'success', title: `${group.title} saved`, description: 'Applied to this demo session — nothing real is configured.' });
  };

  const reset = () => {
    const defaults: Record<string, HqSettingValue> = {};
    for (const field of group.fields) defaults[`${group.id}.${field.id}`] = field.defaultValue;
    setDrafts(defaults);
    toast({ variant: 'success', title: 'Defaults restored', description: 'Nothing changes until you press Save.' });
  };

  return (
    <SectionCard
      title={group.title}
      sub={group.description}
      action={
        <div className="flex items-center gap-3">
          <button type="button" className={`${LINK_ACTION} inline-flex items-center gap-1`} onClick={reset} aria-label={`Reset ${group.title} to defaults`}>
            <RotateCcw size={12} aria-hidden="true" />
            Reset
          </button>
          <button
            type="button"
            className={`${BTN_PRIMARY} h-8 px-3 disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={!dirty}
            data-testid={`button-save-${group.id}`}
            onClick={save}
          >
            Save
          </button>
        </div>
      }
    >
      <div>
        {group.fields.map((field) => {
          const key = `${group.id}.${field.id}`;
          const value = drafts[key];
          return (
            <div key={field.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-5 py-4 last:border-b-0">
              <div className="min-w-0 max-w-[46ch]">
                <p className={PANEL_LABEL}>{field.label}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{field.help}</p>
              </div>
              <div className="shrink-0">
                {field.kind === 'text' && (
                  <input
                    className={`${INPUT_CLASS} h-9 w-full sm:w-72`}
                    value={String(value ?? '')}
                    placeholder={field.placeholder}
                    onChange={(event) => setDraft(key, event.target.value)}
                    aria-label={field.label}
                    data-testid={`input-setting-${group.id}-${field.id}`}
                  />
                )}
                {field.kind === 'toggle' && (
                  <Switch
                    checked={Boolean(value)}
                    onCheckedChange={(checked) => setDraft(key, checked)}
                    aria-label={field.label}
                    data-testid={`switch-setting-${group.id}-${field.id}`}
                  />
                )}
                {field.kind === 'select' && (
                  <Select value={String(value)} onValueChange={(next) => setDraft(key, next)}>
                    <SelectTrigger className="h-9 w-full text-xs sm:w-72" aria-label={field.label} data-testid={`select-setting-${group.id}-${field.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => {
                        const optValue = typeof option === 'string' ? option : option.value;
                        const optLabel = typeof option === 'string' ? option : option.label;
                        return (
                          <SelectItem key={optValue} value={optValue} className="text-xs">{optLabel}</SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

/**
 * Sound preference for HQ confirmation toasts. Unlike the mock groups above,
 * this is a real setting: it persists in this browser and gates the soft ding
 * on success toasts and the lower tone on failure toasts.
 */
function NotificationSoundCard() {
  const { toast } = useToast();
  const soundOn = useSyncExternalStore(subscribeToastSound, isToastSoundEnabled, () => true);

  const handleToggle = (checked: boolean) => {
    setToastSoundEnabled(checked);
    if (checked) {
      toast({
        variant: 'success',
        title: 'Notification sound on',
        description: 'Success confirmations ring softly, like this one.',
      });
    } else {
      toast({ title: 'Notification sound off', description: 'Toasts stay visual only on this browser.' });
    }
  };

  return (
    <SectionCard
      title="Notification sound"
      sub="A real preference, saved to this browser — it controls the chime on HQ confirmation toasts."
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4">
        <div className="min-w-0 max-w-[46ch]">
          <p className={PANEL_LABEL}>Play a soft ding with toasts</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Saves and confirmations ring a soft bell; failures use a lower tone. Turning this off silences both.
          </p>
        </div>
        <Switch
          checked={soundOn}
          onCheckedChange={handleToggle}
          aria-label="Play a soft ding with toasts"
          data-testid="switch-toast-sound"
        />
      </div>
    </SectionCard>
  );
}

export default function OrgSettings() {
  const { authStatus } = useSession();
  const isLive = authStatus === 'signed-in';

  return (
    <AdminPage>
      <PageHeader
        kicker="Organization"
        title="Org settings"
        sub="Program-wide switches and defaults for every provider account. Some features are mock only in the demo."
      />
      <div className="space-y-5">
        {isLive ? (
          <LiveOrgSettingsCard />
        ) : (
          <>
            {HQ_SETTINGS_GROUPS.map((group) => (
              <GroupCard key={group.id} group={group} />
            ))}
            <NotificationSoundCard />
          </>
        )}
      </div>
    </AdminPage>
  );
}
