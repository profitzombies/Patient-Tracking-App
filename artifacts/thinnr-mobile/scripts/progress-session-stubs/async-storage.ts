/**
 * In-memory async-storage stand-in with the backing Map EXPOSED, so the
 * progress-session suite can clear state between scenarios, find the
 * patient snapshot, and rewrite it into a legacy shape (a snapshot saved
 * before hideSessionInstructions existed) to prove hydration tolerates it.
 */
export const store = new Map<string, string>();

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
