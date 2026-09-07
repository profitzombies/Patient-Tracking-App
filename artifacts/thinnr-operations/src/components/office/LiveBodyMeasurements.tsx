/**
 * Body measurements on a LIVE patient record: the shared card fed by the
 * API's visit list, with saves and removals routed through the office-scoped
 * measurement endpoints (server-audited, no values in the audit metadata).
 * After every write the detail query is invalidated so the new column lands
 * immediately; a stale removal surfaces the reload conflict like a weigh-in.
 */
import { BodyMeasurementsCard, localTodayKey, type SaveOutcome, type VisitDraft } from '@/components/patient/BodyMeasurements';
import { ConflictNotice, ForbiddenNotice, useRecordWrite } from '@/components/office/LivePatientEdits';
import {
  OfficeRosterError,
  deleteMeasurementVisit,
  recordMeasurementVisit,
  type OfficeMeasurementVisit,
  type OfficePatientDetail,
} from '@/lib/office-roster';
import type { MeasurementVisit } from '@/lib/body-measurements';

export function LiveBodyMeasurements({ patient, visits, office, canEdit }: {
  patient: OfficePatientDetail['patient'];
  visits: OfficeMeasurementVisit[];
  office: string | null;
  canEdit: boolean;
}) {
  const ctx = { id: patient.identity.id, office, version: patient.version };
  const write = useRecordWrite(ctx);

  const save = async (draft: VisitDraft): Promise<SaveOutcome> => {
    let fieldError: SaveOutcome | null = null;
    const result = await write.run(
      () => recordMeasurementVisit(ctx.id, draft, office),
      {
        success: 'Visit logged',
        failure: 'Visit not logged',
        onField: (field, message) => { fieldError = { ok: false, field, message }; },
      },
    );
    if (result) return { ok: true };
    return fieldError ?? { ok: false, message: write.forbidden ?? 'The visit was not saved. Try again.' };
  };

  const remove = async (visit: MeasurementVisit) => {
    let expectedVersion: string | null = null;
    try {
      expectedVersion = visit.version ?? null;
      await write.run(() => deleteMeasurementVisit(ctx.id, visit.id, expectedVersion, office), { success: 'Visit removed', failure: 'Visit not removed' });
    } catch (error) {
      if (!(error instanceof OfficeRosterError)) throw error;
    }
  };

  const conflict = write.conflict ? <ConflictNotice onReload={() => write.reload()} testId="notice-visit-conflict" /> : null;
  const forbidden = write.forbidden ? <ForbiddenNotice message={write.forbidden} /> : null;

  return (
    <BodyMeasurementsCard
      visits={visits}
      patientName={patient.identity.name}
      canEdit={canEdit}
      todayKey={localTodayKey()}
      onSave={save}
      onRemove={remove}
      dialogNotice={<>{conflict}{forbidden}</>}
      bodyNotice={conflict || forbidden ? <div className="mb-4 space-y-2">{conflict}{forbidden}</div> : null}
    />
  );
}
