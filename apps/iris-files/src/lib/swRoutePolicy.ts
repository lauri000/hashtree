export function shouldInterceptHtreeRequestForWorker(
  path: string,
  clientKey: string | null,
  rangeHeader: string | null,
): boolean {
  if (!path.startsWith('/htree/')) {
    return false;
  }

  // Let ordinary app-shell HTML/JS/CSS/image requests hit the embedded server
  // directly. The worker-streaming path is reserved for client-keyed media
  // fetches and explicit byte-range requests.
  return !!clientKey || !!rangeHeader;
}
