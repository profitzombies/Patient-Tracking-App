/**
 * Node stand-in for the pose illustration requires (tsx cannot load .jpg
 * modules); numbers stand in for Metro asset ids.
 */
import type { SessionAngle } from '@/lib/progress-session';

export const POSE_IMAGES: Record<SessionAngle, number> = { front: 1, side: 2, back: 3 };
