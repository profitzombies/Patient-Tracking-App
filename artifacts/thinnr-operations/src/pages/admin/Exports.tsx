/**
 * HQ exports page — CSV exports scoped to the signed-in HQ role.
 *
 * The office picker lists the live provider directory when the role can read
 * it; roles without directory access (Content) still see the network-wide
 * kinds the server allows them. The shared header date range drives every
 * ranged export.
 */
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { ExportsPanel, type ExportOfficeOption } from '@/components/exports/ExportsPanel';
import { useHqData } from '@/contexts/hq-data';
import { useSession } from '@/contexts/session';

export default function Exports() {
  const { accounts, accountsStatus } = useHqData();
  const { authStatus } = useSession();

  const officeOptions: ExportOfficeOption[] =
    authStatus === 'signed-in' && accountsStatus === 'ready'
      ? accounts.map((account) => ({ id: account.id, name: account.officeName }))
      : [];

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title="Exports"
        sub="Take office comparisons, patient activity summaries, audit events, training completion, and the provider directory out as CSV. Every export is scoped to your role and logged."
        action={<DateRangeControl />}
      />
      {authStatus !== 'signed-in' && (
        <p className="mb-4 rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="text-exports-demo-note">
          The guided demo has no export queue. Sign in with an HQ account to generate real files.
        </p>
      )}
      <ExportsPanel officeOptions={officeOptions} title="Request an export" />
    </AdminPage>
  );
}
