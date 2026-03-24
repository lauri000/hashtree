const MEDIA_RETRY_PARAM = 'htree_img_retry';

export const MAX_MEDIA_IMAGE_RETRIES = 2;

export function isRetryableMediaImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes('/htree/');
}

export function appendMediaImageRetryParam(url: string, attempt: number): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${MEDIA_RETRY_PARAM}=${Date.now()}-${attempt}`;
}

export function getMediaImageRetryDelayMs(attempt: number): number {
  return 350 * attempt;
}
