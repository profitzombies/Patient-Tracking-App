export const GRAMS_PER_OUNCE = 28.3495;

export function useFoodLogging() {
  return {
    add: async () => {},
    remove: async () => {},
    update: async () => {},
    clear: () => {},
    remember: () => {},
    pending: false,
    items: [],
  };
}