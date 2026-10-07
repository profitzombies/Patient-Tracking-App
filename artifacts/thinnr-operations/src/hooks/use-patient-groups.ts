/**
 * Office patient groups for the Patients roster and the patient record.
 *
 * One hook serves both data paths so the manager, the detail control, the
 * roster tags and the Group filter render identically:
 *
 * - Live (a signed-in office, or an HQ admin drilled into an office): the
 *   group list comes from the office API, mutations go through it, and every
 *   write invalidates the roster and the patient-record queries so the tags
 *   and the match count update without a reload. Loading and errors surface
 *   as such — a slow or failed list never falls back to demo groups.
 * - Demo (the signed-out guided demo): the seeded module store, mutated for
 *   the session only.
 *
 * The caller decides live vs demo from auth state (`useLiveRoster` /
 * `LivePatientDetail`), never from missing data.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/contexts/session';
import { useProviderScope } from '@/contexts/provider-scope';
import { officeRosterQueryKey } from '@/components/office/LiveRoster';
import {
  addDemoPatientGroupMember,
  createDemoPatientGroup,
  deleteDemoPatientGroup,
  demoGroupIdsByPatient,
  removeDemoPatientGroupMember,
  updateDemoPatientGroup,
  useDemoPatientGroupsState,
} from '@/data/patient-groups-demo';
import {
  addOfficePatientGroupMember,
  createOfficePatientGroup,
  deleteOfficePatientGroup,
  fetchOfficePatientGroups,
  removeOfficePatientGroupMember,
  updateOfficePatientGroup,
  type PatientGroup,
  type PatientGroupInput,
} from '@/lib/office-roster';
import type { FieldOption } from '@/lib/roster-filters';

export function officePatientGroupsQueryKey(office: string | null) {
  return ['office-patient-groups', office ?? 'own-office'] as const;
}

export interface PatientGroupsApi {
  /** Alphabetical office groups; empty while loading or when there are none. */
  groups: PatientGroup[];
  /** True once the list is known (live loaded, or demo). Filters that name a group must not be pruned before this. */
  ready: boolean;
  isLoading: boolean;
  error: Error | null;
  /** False under HQ drill-in (and sealed demo scopes): read-only controls. */
  canEdit: boolean;
  /** Group filter options for the roster filter builder. */
  options: FieldOption[];
  /** Demo only: patient id → group ids (live rows carry their own groupIds). */
  demoGroupIdsByPatient: ReadonlyMap<string, readonly string[]>;
  create: (input: PatientGroupInput) => Promise<PatientGroup>;
  rename: (groupId: string, input: Partial<PatientGroupInput>) => Promise<PatientGroup>;
  remove: (groupId: string) => Promise<{ memberCount: number }>;
  addMember: (groupId: string, patientId: string) => Promise<void>;
  removeMember: (groupId: string, patientId: string) => Promise<void>;
  refetch: () => void;
}

export function usePatientGroups({ live, office }: { live: boolean; office: string | null }): PatientGroupsApi {
  const { authUser } = useSession();
  const scope = useProviderScope();
  const queryClient = useQueryClient();
  const demo = useDemoPatientGroupsState();

  const query = useQuery({
    queryKey: [...officePatientGroupsQueryKey(office), authUser?.id],
    queryFn: () => fetchOfficePatientGroups(office),
    enabled: live,
    staleTime: 15_000,
  });

  // Membership rides the roster rows and the patient record: refresh both,
  // plus the list itself (member counts), after any write.
  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: officePatientGroupsQueryKey(office) }),
      queryClient.invalidateQueries({ queryKey: officeRosterQueryKey(office) }),
      queryClient.invalidateQueries({ queryKey: ['office-patient', office ?? 'own-office'] }),
    ]);
  }, [queryClient, office]);

  const liveApi = useMemo<Omit<PatientGroupsApi, 'options' | 'demoGroupIdsByPatient'>>(() => ({
    groups: query.data?.groups ?? [],
    ready: query.data != null,
    isLoading: query.isPending,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    canEdit: query.data?.canEdit ?? false,
    create: async (input) => {
      const result = await createOfficePatientGroup(input, office);
      await invalidate();
      return result.group;
    },
    rename: async (groupId, input) => {
      const result = await updateOfficePatientGroup(groupId, input, office);
      await invalidate();
      return result.group;
    },
    remove: async (groupId) => {
      const result = await deleteOfficePatientGroup(groupId, office);
      await invalidate();
      return { memberCount: result.memberCount };
    },
    addMember: async (groupId, patientId) => {
      await addOfficePatientGroupMember(groupId, patientId, office);
      await invalidate();
    },
    removeMember: async (groupId, patientId) => {
      await removeOfficePatientGroupMember(groupId, patientId, office);
      await invalidate();
    },
    refetch: () => { void query.refetch(); },
  }), [query, office, invalidate]);

  const demoApi = useMemo<Omit<PatientGroupsApi, 'options' | 'demoGroupIdsByPatient'>>(() => ({
    groups: demo.groups,
    ready: true,
    isLoading: false,
    error: null,
    // The guided HQ drill-in persona sees the office's groups read-only, like real HQ.
    canEdit: scope == null,
    create: async (input) => createDemoPatientGroup(input),
    rename: async (groupId, input) => updateDemoPatientGroup(groupId, input),
    remove: async (groupId) => deleteDemoPatientGroup(groupId),
    addMember: async (groupId, patientId) => { addDemoPatientGroupMember(groupId, patientId); },
    removeMember: async (groupId, patientId) => { removeDemoPatientGroupMember(groupId, patientId); },
    refetch: () => {},
  }), [demo.groups, scope]);

  const api = live ? liveApi : demoApi;
  const options = useMemo(() => api.groups.map((group) => ({ value: group.id, label: group.name })), [api.groups]);
  const byPatient = useMemo(() => (live ? new Map<string, readonly string[]>() : demoGroupIdsByPatient(demo)), [live, demo]);

  return useMemo(() => ({ ...api, options, demoGroupIdsByPatient: byPatient }), [api, options, byPatient]);
}
