/**
 * Seeded patient groups for the signed-out guided demo.
 *
 * The demo office has three operational groups — an employer cohort (MJH),
 * a clinic-day cohort and a transition cohort — with deterministic
 * membership drawn from the seeded roster (`pat_1xx` ids, never the closed
 * chart). Staff can create, rename, delete and re-populate groups during the
 * session; every change is held in this module and vanishes on reload, so the
 * demo never touches the server. Real offices read and write through the
 * office API instead (see hooks/use-patient-groups.ts), chosen by auth state.
 */
import { useSyncExternalStore } from 'react';
import type { PatientGroup } from '@/lib/office-roster';

const DEMO_STAMP = '2026-08-04T15:00:00.000Z';

interface SeededGroup extends PatientGroup {
  /** Seeded roster indexes (pat_{100 + index}). */
  memberIndexes: readonly number[];
}

const SEEDED: readonly SeededGroup[] = [
  {
    id: 'grp_demo_mjh',
    name: 'MJH',
    description: 'MJH employer wellness cohort',
    memberCount: 0,
    createdAt: DEMO_STAMP,
    updatedAt: DEMO_STAMP,
    memberIndexes: [1, 5, 9, 13, 17, 21],
  },
  {
    id: 'grp_demo_tuesday',
    name: 'Tuesday clinic',
    description: 'Seen on the Tuesday in-office block',
    memberCount: 0,
    createdAt: DEMO_STAMP,
    updatedAt: DEMO_STAMP,
    memberIndexes: [2, 6, 14, 22, 26],
  },
  {
    id: 'grp_demo_glp1',
    name: 'GLP-1 transition',
    description: null,
    memberCount: 0,
    createdAt: DEMO_STAMP,
    updatedAt: DEMO_STAMP,
    memberIndexes: [3, 11, 19],
  },
];

export interface DemoPatientGroupsState {
  groups: PatientGroup[];
  /** group id → patient ids, insertion-ordered. */
  members: ReadonlyMap<string, readonly string[]>;
}

function seededState(): DemoPatientGroupsState {
  const members = new Map<string, readonly string[]>();
  const groups = SEEDED.map(({ memberIndexes, ...group }) => {
    const ids = memberIndexes.map((index) => `pat_${100 + index}`);
    members.set(group.id, ids);
    return { ...group, memberCount: ids.length };
  });
  return { groups, members };
}

let state: DemoPatientGroupsState = seededState();
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: DemoPatientGroupsState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getDemoPatientGroupsState(): DemoPatientGroupsState {
  return state;
}

/** Test hook: back to the seeded groups and membership. */
export function resetDemoPatientGroups() {
  nextId = 1;
  emit(seededState());
}

export function useDemoPatientGroupsState(): DemoPatientGroupsState {
  return useSyncExternalStore(subscribe, getDemoPatientGroupsState, getDemoPatientGroupsState);
}

/** patient id → group ids, derived from the current membership map. */
export function demoGroupIdsByPatient(current: DemoPatientGroupsState = state): ReadonlyMap<string, readonly string[]> {
  const byPatient = new Map<string, string[]>();
  for (const group of current.groups) {
    for (const patientId of current.members.get(group.id) ?? []) {
      byPatient.set(patientId, [...(byPatient.get(patientId) ?? []), group.id]);
    }
  }
  return byPatient;
}

export const DEMO_GROUP_NAME_TAKEN = 'A group with that name already exists.';
export const DEMO_GROUP_NOT_FOUND = 'No group found for this office.';

const sameName = (a: string, b: string) => a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0;
const sortGroups = (groups: PatientGroup[]) => [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

function requireGroup(groupId: string): PatientGroup {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(DEMO_GROUP_NOT_FOUND);
  return group;
}

export function createDemoPatientGroup(input: { name: string; description?: string | null }): PatientGroup {
  const name = input.name.trim();
  if (!name) throw new Error('Enter a group name.');
  if (state.groups.some((group) => sameName(group.name, name))) throw new Error(DEMO_GROUP_NAME_TAKEN);
  const now = new Date().toISOString();
  const group: PatientGroup = {
    id: `grp_demo_new_${nextId++}`,
    name,
    description: input.description?.trim() ? input.description.trim() : null,
    memberCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const members = new Map(state.members);
  members.set(group.id, []);
  emit({ groups: sortGroups([...state.groups, group]), members });
  return group;
}

export function updateDemoPatientGroup(groupId: string, input: { name?: string; description?: string | null }): PatientGroup {
  const existing = requireGroup(groupId);
  const name = input.name === undefined ? existing.name : input.name.trim();
  if (!name) throw new Error('Enter a group name.');
  if (state.groups.some((group) => group.id !== groupId && sameName(group.name, name))) throw new Error(DEMO_GROUP_NAME_TAKEN);
  const updated: PatientGroup = {
    ...existing,
    name,
    description: input.description === undefined ? existing.description : input.description?.trim() ? input.description.trim() : null,
    updatedAt: new Date().toISOString(),
  };
  emit({ groups: sortGroups(state.groups.map((group) => (group.id === groupId ? updated : group))), members: state.members });
  return updated;
}

export function deleteDemoPatientGroup(groupId: string): { deleted: boolean; memberCount: number } {
  const existing = requireGroup(groupId);
  const members = new Map(state.members);
  members.delete(groupId);
  emit({ groups: state.groups.filter((group) => group.id !== groupId), members });
  return { deleted: true, memberCount: existing.memberCount };
}

function withMembers(groupId: string, ids: readonly string[]) {
  const members = new Map(state.members);
  members.set(groupId, ids);
  emit({
    groups: state.groups.map((group) => (group.id === groupId ? { ...group, memberCount: ids.length, updatedAt: new Date().toISOString() } : group)),
    members,
  });
}

export function addDemoPatientGroupMember(groupId: string, patientId: string): { added: boolean } {
  requireGroup(groupId);
  const current = state.members.get(groupId) ?? [];
  if (current.includes(patientId)) return { added: false };
  withMembers(groupId, [...current, patientId]);
  return { added: true };
}

export function removeDemoPatientGroupMember(groupId: string, patientId: string): { removed: boolean } {
  requireGroup(groupId);
  const current = state.members.get(groupId) ?? [];
  if (!current.includes(patientId)) return { removed: false };
  withMembers(groupId, current.filter((id) => id !== patientId));
  return { removed: true };
}
