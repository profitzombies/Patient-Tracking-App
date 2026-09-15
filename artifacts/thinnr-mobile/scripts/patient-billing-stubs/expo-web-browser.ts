export const openedBrowserUrls: string[] = [];
export async function openBrowserAsync(url: string): Promise<{ type: 'dismiss' }> {
  openedBrowserUrls.push(url);
  return { type: 'dismiss' };
}