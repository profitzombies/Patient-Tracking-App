import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
export { LoadingRegion, ChartSkeleton, RowsSkeleton } from '@/components/ui/skeleton';

const rows = Array.from({ length: 6 }, (_, index) => index);

export function PatientRosterLoading() {
  return (
    <LoadingRegion label="Loading patient roster" testId="loading-patient-roster">
      <div className="divide-y divide-border md:hidden">
        {rows.slice(0, 5).map((row) => (
          <div key={row} className="p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden max-w-full overflow-hidden md:block">
        <table className="w-full table-fixed text-left">
          <thead className="border-b border-border bg-secondary">
            <tr>
              {[21, 16, 12, 14, 17, 6, 10].map((width, index) => (
                <th key={index} style={{ width: `${width}%` }} className="px-3 py-3">
                  <Skeleton className="h-2.5 w-3/4 bg-primary/[.07]" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row} className="border-b border-border last:border-0">
                <td className="px-3 py-3"><div className="flex items-center gap-3"><Skeleton className="h-8 w-8 shrink-0" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-2 w-full" /></div></div></td>
                <td className="px-3 py-3"><Skeleton className="h-6 w-20" /></td>
                <td className="px-3 py-3"><Skeleton className="h-3 w-20" /></td>
                <td className="px-3 py-3"><Skeleton className="h-7 w-24" /></td>
                <td className="px-3 py-3"><Skeleton className="h-7 w-28" /></td>
                <td className="px-3 py-3"><Skeleton className="h-3 w-9" /></td>
                <td className="px-3 py-3"><Skeleton className="ml-auto h-7 w-16" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </LoadingRegion>
  );
}

function PanelSkeleton({ tall = false }: { tall?: boolean }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="border-b border-border bg-paper-alt px-5 py-4">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="mt-2 h-2.5 w-2/3" />
      </div>
      <div className="space-y-3 p-5">
        <Skeleton className={tall ? 'h-40 w-full' : 'h-12 w-full'} />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

function ProgressSummarySkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="border-b border-border bg-paper-alt px-5 py-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-2 h-2.5 w-48 max-w-full" />
      </div>
      <div className="p-5 md:p-6">
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="bg-card p-4">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="mt-2 h-5 w-24 max-w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-5 h-2.5 w-full rounded-full" />
        <Skeleton className="ml-auto mt-2 h-2.5 w-28" />
      </div>
    </div>
  );
}

export function PatientDetailLoading() {
  return (
    <LoadingRegion
      label="Loading patient record"
      className="mx-auto max-w-[1320px] px-5 py-7 md:px-8"
      testId="loading-patient-detail"
    >
      <header className="mb-6 border-b border-border pb-6">
        <Skeleton className="mb-5 h-3 w-28" />
        <div className="flex items-start gap-4">
          <Skeleton className="h-16 w-16 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-3 pt-1">
            <Skeleton className="h-7 w-56 max-w-full" />
            <Skeleton className="h-3 w-72 max-w-full" />
            <Skeleton className="h-3 w-96 max-w-full" />
          </div>
        </div>
      </header>
      <div className="mb-5 flex gap-2">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-20" />
      </div>
      <main className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <ProgressSummarySkeleton />
          <PanelSkeleton tall />
          <PanelSkeleton />
          <PanelSkeleton />
        </div>
        <aside className="space-y-5">
          <PanelSkeleton />
          <PanelSkeleton />
          <PanelSkeleton />
        </aside>
        <div className="lg:col-span-3"><PanelSkeleton tall /></div>
      </main>
    </LoadingRegion>
  );
}