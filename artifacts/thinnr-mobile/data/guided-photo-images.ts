/**
 * Posing example illustrations for the guided photo session — same flat
 * vector family as the seeded recipe/progress art (slate blue-grey figure,
 * faceless, off-white ground). Metro only bundles assets named in literal
 * require() calls, so the map is spelled out per angle — the same rule as
 * data/recipe-images.ts.
 *
 * On web these double as the demo "captured frames": live capture is
 * native-only, so the simulated camera hands these back at the shutter.
 */
import type { ImageSourcePropType } from 'react-native';
import type { GuidedAngle } from '@/lib/guided-photos';

export const GUIDED_POSE_IMAGES: Record<GuidedAngle, ImageSourcePropType> = {
  front: require('@/assets/images/progress/pose-front.jpg'),
  side: require('@/assets/images/progress/pose-side.jpg'),
  back: require('@/assets/images/progress/pose-back.jpg'),
};
