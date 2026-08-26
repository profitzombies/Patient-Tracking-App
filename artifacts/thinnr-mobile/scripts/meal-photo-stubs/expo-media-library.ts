/**
 * Node stand-in for expo-media-library: the camera surface's corner
 * thumbnail does a quiet permission READ (getPermissionsAsync never
 * prompts) and a newest-first single-asset page; both are scripted here.
 */
export const mediaState = {
  permission: { granted: true, accessPrivileges: 'all' } as {
    granted: boolean;
    accessPrivileges?: 'all' | 'limited' | 'none';
  },
  /** Newest-first photo assets returned by getAssetsAsync. */
  recent: [{ id: 'recent-1', uri: 'ph://recent-1' }] as Array<{ id: string; uri: string }>,
  getAssetsCalls: 0,
  /** When set, getAssetsAsync rejects (the thumbnail must fail quietly). */
  failGetAssets: false,
};

export const MediaType = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  unknown: 'unknown',
} as const;

export const SortBy = {
  default: 'default',
  creationTime: 'creationTime',
} as const;

export async function getPermissionsAsync(): Promise<{
  granted: boolean;
  accessPrivileges?: string;
}> {
  return mediaState.permission;
}

export async function getAssetsAsync(_options?: unknown): Promise<{
  assets: Array<{ id: string; uri: string }>;
  endCursor: string;
  hasNextPage: boolean;
  totalCount: number;
}> {
  mediaState.getAssetsCalls += 1;
  if (mediaState.failGetAssets) throw new Error('media library unavailable');
  return {
    assets: mediaState.recent,
    endCursor: '',
    hasNextPage: false,
    totalCount: mediaState.recent.length,
  };
}
