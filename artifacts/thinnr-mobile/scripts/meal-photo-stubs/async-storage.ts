/**
 * In-memory Node stand-in for @react-native-async-storage/async-storage
 * (mapped by tsconfig.meal-photo.json) so PatientProvider can hydrate and
 * persist under tsx. Fresh per process — each suite run starts empty.
 */
const store = new Map<string, string>();

export default {
  async getItem(key: string): Promise<string | null> {
    return store.has(key) ? (store.get(key) as string) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
};
