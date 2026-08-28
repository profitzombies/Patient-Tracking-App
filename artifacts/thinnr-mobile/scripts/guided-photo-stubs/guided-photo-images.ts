/**
 * Node stand-in for data/guided-photo-images (whose static require() calls
 * pull binary .jpg files tsx cannot load). Sentinels carry their angle so
 * the expo-asset stub can mint recognizable URIs.
 */
import type { GuidedAngle } from '../../lib/guided-photos';

export const GUIDED_POSE_IMAGES: Record<GuidedAngle, unknown> = {
  front: { angle: 'front' },
  side: { angle: 'side' },
  back: { angle: 'back' },
};
