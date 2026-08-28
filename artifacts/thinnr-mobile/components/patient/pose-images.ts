/**
 * Pose illustrations for the guided session's setup step, isolated here so
 * the Node verify suite can remap this module (tsx cannot load .jpg
 * requires) while the app bundles the real assets.
 */
import type { SessionAngle } from '@/lib/progress-session';

export const POSE_IMAGES: Record<SessionAngle, number> = {
  front: require('@/assets/images/progress/pose-front.jpg'),
  side: require('@/assets/images/progress/pose-side.jpg'),
  back: require('@/assets/images/progress/pose-back.jpg'),
};
