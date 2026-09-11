export const state = {
  invalidated: [] as Array<{ queryKey: readonly unknown[] }>,
};

export function resetQueryClient(): void {
  state.invalidated = [];
}

export function useQueryClient() {
  return {
    invalidateQueries: async (input: { queryKey: readonly unknown[] }) => {
      state.invalidated.push(input);
    },
  };
}