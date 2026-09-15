export function formatBytes(bytes: number, decimals = 1) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${Number((bytes / 1024 ** index).toFixed(decimals))} ${sizes[index]}`;
}

export function apiError(error: unknown, fallback: string) {
  if (error && typeof error === 'object') {
    const body = (error as { data?: { error?: string } }).data;
    if (body?.error) return body.error;
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return fallback;
}
/**
 * Open a signed download URL without replacing the app. Browser-viewable
 * types (PDF, images, text) render inline from a signed GET, so navigating
 * the current tab to them would drop the user out of the drive. Open a blank
 * tab first (a plain window.open with a "noopener" feature string returns
 * null in some browsers even when the tab opened), sever its opener, then
 * point it at the file. Only when the popup was actually blocked do we fall
 * back to the current tab so the click still does something.
 */
export function openDownload(url: string) {
  const tab = window.open('', '_blank');
  if (!tab) {
    window.location.assign(url);
    return;
  }
  tab.opener = null;
  tab.location.href = url;
}
