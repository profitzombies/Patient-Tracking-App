export async function requestMediaLibraryPermissionsAsync() {
  return { granted: false };
}

export async function launchImageLibraryAsync() {
  return { canceled: true as const, assets: [] as never[] };
}