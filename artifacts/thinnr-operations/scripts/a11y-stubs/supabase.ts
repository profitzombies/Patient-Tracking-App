/**
 * Swappable stand-in for '@/lib/supabase' used by
 * scripts/verify-training-a11y.tsx (mapped via tsconfig.a11y.json).
 * The real module calls createClient(import.meta.env…) at load, which
 * crashes under plain Node. The suite only renders — the sole call the
 * render path can reach is auth.getSession() from the training-media
 * client, which must resolve to "no session" (open demo posture).
 */
export const supabase = {
  auth: {
    async getSession() {
      return { data: { session: null }, error: null };
    },
  },
} as any;
