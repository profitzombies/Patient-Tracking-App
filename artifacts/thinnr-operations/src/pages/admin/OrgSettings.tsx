/**
 * Org-level settings for the THINNR program.
 *
 * Two personas, two sources of truth:
 * - Signed-in HQ admins get the LIVE policy contract (LivePolicySettings):
 *   persisted on the server, versioned, audited per field, and read by the
 *   notification sender, the staff inbox, the coach route, and exports.
 * - The guided demo keeps the seeded GroupCards below: values load from the
 *   session HQ store and edit as per-group drafts that persist for this demo
 *   session only. Nothing configures any real system, and the copy says so.
 */
import { useState, useSyncExternalStore } from 'react';
import { RotateCcw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { isToastSoundEnabled, setToastSoundEnabled, subscribeToastSound } from '@/lib/toast-sound';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BTN_PRIMARY, INPUT_CLASS, LINK_ACTION, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { HQ_SETTINGS_GROUPS, type HqSettingValue, type HqSettingsGroup } from '@/data/hq/settings';
import { useSession } from '@/contexts/session';
import { LivePolicySettings } from './org-settings/LivePolicySettings';
import { BillingModeSettings } from '@/components/billing/BillingModeSettings';

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
  const { authStatus, hqRole } = useSession();
  const isLive = authStatus === 'signed-in';
  // Payment mode is an Admin/Super Admin control, and the policy cards below
  // already tell everyone else they lack access — a Support user must not even
  // ask the server for this page's settings.
  const canEdit = hqRole === 'Admin' || hqRole === 'Super Admin';

  return (
    <AdminPage>
      <PageHeader
        kicker="Organization"
        title="Org settings"
        sub={
          isLive
            ? 'Program-wide policies every provider account inherits. Saves apply live, are versioned, and land in the audit log.'
            : 'Program-wide switches and defaults for every provider account. Some features are mock only in the demo.'
        }
      />
      <div className="space-y-5">
        {isLive ? (
          <>
            {canEdit && <BillingModeSettings />}
            <LivePolicySettings />
          </>
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
