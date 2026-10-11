/**
 * HQ Diet library — every diet patients can pick, with its review status.
 *
 * LIVE data only: the list is the database the patient app reads from, so
 * what HQ sees here is exactly what patients can (or cannot yet) choose. The
 * owners sign off on content and counsel reviews condition claims before an
 * entry is published; drafts and reviewed-but-unpublished entries never
 * reach patients. The tracking-only option is always available and carries no
 * review status to manage.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Pencil, RotateCw } from 'lucide-react';
import {
  getListHqDietLibraryQueryKey,
  updateHqDietLibrarySettings,
  useListHqDietLibrary,
  type DietLibrarySettings,
  type HqDietLibraryEntry,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/contexts/session';
import { AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import { formatLocalDate } from '@/lib/local-time';
import {
  COMPLEXITY_LABELS,
  DIET_LIBRARY_PATH,
  JUST_TRACKING_SLUG,
  NEUTRAL_CHIP,
  REVIEW_STATUS_HELP,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_ORDER,
  SCREENING_LABELS,
  countLibrary,
  describeApiProblem,
  filterLibrary,
  reviewStatusChipClass,
  type LibraryStatusFilter,
} from '@/lib/diet-library';

const FILTERS: Array<{ value: LibraryStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  ...REVIEW_STATUS_ORDER.map((status) => ({ value: status, label: REVIEW_STATUS_LABELS[status] })),
];

function StatusChip({ entry }: { entry: HqDietLibraryEntry }) {
  if (entry.slug === JUST_TRACKING_SLUG) {
    return <span className={NEUTRAL_CHIP} data-testid={`chip-diet-status-${entry.slug}`}>Always available</span>;
  }
  return (
    <span className={reviewStatusChipClass(entry.reviewStatus)} data-testid={`chip-diet-status-${entry.slug}`} title={REVIEW_STATUS_HELP[entry.reviewStatus]}>
      {REVIEW_STATUS_LABELS[entry.reviewStatus]}
    </span>
  );
}

function SettingsCard({ settings }: { settings: DietLibrarySettings }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [disclaimer, setDisclaimer] = useState(settings.disclaimer);
  const [oversight, setOversight] = useState(settings.oversightNoteText);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const open = () => { setDisclaimer(settings.disclaimer); setOversight(settings.oversightNoteText); setProblem(null); setEditing(true); };
  const save = async () => {
    const body: { disclaimer?: string; oversightNoteText?: string } = {};
    if (disclaimer.trim() !== settings.disclaimer) body.disclaimer = disclaimer.trim();
    if (oversight.trim() !== settings.oversightNoteText) body.oversightNoteText = oversight.trim();
    if (Object.keys(body).length === 0) { setEditing(false); return; }
    if ((body.disclaimer !== undefined && (body.disclaimer.length < 1 || body.disclaimer.length > 2000))
      || (body.oversightNoteText !== undefined && (body.oversightNoteText.length < 1 || body.oversightNoteText.length > 2000))) {
      setProblem('Both texts must be 1–2000 characters.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await updateHqDietLibrarySettings(body);
      await queryClient.invalidateQueries({ queryKey: getListHqDietLibraryQueryKey() });
      toast({ variant: 'success', title: 'Library wording saved', description: 'Patients see the new text the next time the library loads.' });
      setEditing(false);
    } catch (error) {
      setProblem(describeApiProblem(error, 'The wording could not be saved. Try again.').message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Shared wording"
      sub="Shown with every diet in the patient app. Counsel reviews the disclaimer."
      action={!editing && (
        <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={open} data-testid="button-edit-settings">
          <Pencil className="h-3 w-3" aria-hidden /> Edit wording
        </button>
      )}
    >
      {editing ? (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }} data-testid="form-settings">
          <label className="block text-xs">
            <span className="font-semibold text-foreground">Disclaimer</span>
            <textarea className={`${INPUT_CLASS} mt-1 min-h-[96px] w-full`} value={disclaimer} onChange={(event) => setDisclaimer(event.target.value)} data-testid="input-settings-disclaimer" />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-foreground">Oversight note</span>
            <span className="ml-1 text-muted-foreground">(shown on plans that recommend care-team support)</span>
            <textarea className={`${INPUT_CLASS} mt-1 min-h-[64px] w-full`} value={oversight} onChange={(event) => setOversight(event.target.value)} data-testid="input-settings-oversight" />
          </label>
          {problem && <p className="text-xs text-destructive" role="alert" data-testid="text-settings-problem">{problem}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={`${BTN_SECONDARY} px-3 py-2`} onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className={`${BTN_PRIMARY} px-4 py-2`} disabled={busy} data-testid="button-save-settings">{busy ? 'Saving…' : 'Save wording'}</button>
          </div>
        </form>
      ) : (
        <dl className="space-y-3 text-xs">
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Disclaimer</dt>
            <dd className="mt-1 max-w-[80ch] leading-relaxed text-foreground" data-testid="text-settings-disclaimer">{settings.disclaimer}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Oversight note</dt>
            <dd className="mt-1 max-w-[80ch] leading-relaxed text-foreground" data-testid="text-settings-oversight">{settings.oversightNoteText}</dd>
          </div>
        </dl>
      )}
    </SectionCard>
  );
}

export default function DietLibrary() {
  const { authUser } = useSession();
  const query = useListHqDietLibrary({ query: { queryKey: [...getListHqDietLibraryQueryKey(), authUser?.id], retry: 1 } });
  const [status, setStatus] = useState<LibraryStatusFilter>('all');
  const [search, setSearch] = useState('');

  const entries = useMemo(() => query.data?.entries ?? [], [query.data]);
  const counts = useMemo(() => countLibrary(entries), [entries]);
  const visible = useMemo(() => filterLibrary(entries, status, search), [entries, status, search]);
  const unavailable = query.isPending || query.isError;
  const tile = (value: number) => (unavailable ? (query.isError ? 'Error' : '—') : String(value));

  return (
    <AdminPage>
      <PageHeader
        kicker="Learning"
        title="Diet library"
        sub="The 26 diet frameworks patients can choose from, plus “just tracking”. Only published entries reach the patient app; the owners sign off on content and counsel reviews condition claims before anything is published."
        action={(
          <button type="button" className={`${BTN_SECONDARY} px-3 py-2`} onClick={() => void query.refetch()} disabled={query.isFetching} data-testid="button-refresh-library">
            <RotateCw className={`h-3.5 w-3.5 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden /> Refresh
          </button>
        )}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label="Published" value={tile(counts.byStatus.published)} detail="Live for patients" testId="text-metric-published" />
        <MetricTile label="Reviewed" value={tile(counts.byStatus.reviewed)} detail="Signed off, not yet live" testId="text-metric-reviewed" />
        <MetricTile label="Drafts" value={tile(counts.byStatus.draft)} detail="Patients never see drafts" testId="text-metric-draft" />
        <MetricTile label="Retired" value={tile(counts.byStatus.retired)} testId="text-metric-retired" />
      </div>

      <SectionCard
        title="Entries"
        sub={unavailable ? undefined : `${counts.total} entries · ${counts.byStatus.published} published`}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Filter by review status" className="flex flex-wrap gap-1">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  role="tab"
                  aria-selected={status === filter.value}
                  className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em] transition ${status === filter.value ? 'bg-navy text-white' : 'text-muted-foreground hover:bg-accent'}`}
                  onClick={() => setStatus(filter.value)}
                  data-testid={`tab-status-${filter.value}`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className={`${INPUT_CLASS} h-8 w-44 text-[11px]`}
              placeholder="Search diets"
              aria-label="Search diets"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              data-testid="input-search-library"
            />
          </div>
        )}
      >
        {query.isPending ? (
          <p className="py-6 text-center text-xs text-muted-foreground" data-testid="status-library-loading">Loading the library…</p>
        ) : query.isError ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center" role="alert" data-testid="text-library-error">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            <p className="text-xs text-destructive">{describeApiProblem(query.error, 'The library could not be loaded.').message}</p>
            <button type="button" className={`${BTN_SECONDARY} px-3 py-2`} onClick={() => void query.refetch()} data-testid="button-retry-library">Try again</button>
          </div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground" data-testid="text-library-empty">No entries match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                  <th scope="col" className="px-5 py-3 font-bold">Diet</th>
                  <th scope="col" className="px-3 py-3 font-bold">Complexity</th>
                  <th scope="col" className="px-3 py-3 font-bold">Screening</th>
                  <th scope="col" className="px-3 py-3 font-bold">Flags</th>
                  <th scope="col" className="px-3 py-3 font-bold">Status</th>
                  <th scope="col" className="px-3 py-3 font-bold">Version</th>
                  <th scope="col" className="px-3 py-3 font-bold">Updated</th>
                  <th scope="col" className="px-5 py-3 text-right font-bold"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr key={entry.slug} className="border-b border-border/60 align-middle last:border-b-0" data-testid={`row-diet-${entry.slug}`}>
                    <td className="max-w-[320px] px-5 py-3">
                      <Link href={`${DIET_LIBRARY_PATH}/${entry.slug}`} className="font-semibold text-foreground hover:text-primary hover:underline" data-testid={`link-diet-${entry.slug}`}>
                        {entry.name}
                      </Link>
                      <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{entry.summary}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{COMPLEXITY_LABELS[entry.complexity]}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {entry.screeningQuestions.length === 0 ? '—' : entry.screeningQuestions.map((question) => SCREENING_LABELS[question]).join(', ')}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {entry.pregnancyBlocked && <span className={NEUTRAL_CHIP} data-testid={`chip-pregnancy-${entry.slug}`}>Pregnancy block</span>}
                        {entry.oversightRecommended && <span className={NEUTRAL_CHIP}>Oversight</span>}
                        {!entry.pregnancyBlocked && !entry.oversightRecommended && <span className="text-muted-foreground">—</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3"><StatusChip entry={entry} /></td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted-foreground" data-testid={`text-version-${entry.slug}`}>v{entry.version}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{formatLocalDate(entry.updatedAt)}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      <Link href={`${DIET_LIBRARY_PATH}/${entry.slug}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline" aria-label={`Open ${entry.name}`}>
                        Open <ChevronRight className="h-3 w-3" aria-hidden />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {query.data && <SettingsCard key={`${query.data.settings.disclaimer}|${query.data.settings.oversightNoteText}`} settings={query.data.settings} />}
    </AdminPage>
  );
}
