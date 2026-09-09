let value = {
  status: 'unavailable' as 'loading' | 'ready' | 'unavailable' | 'error',
  roster: null as null | {
    office: { providerId: string; officeName: string; providerCode: string };
    patients: Array<{ id: string }>;
  },
  error: null as string | null,
  refresh: async () => {},
};

export function setOfficeRoster(next: Partial<typeof value>): void {
  value = { ...value, ...next };
}

export function useOfficeRoster() {
  return value;
}