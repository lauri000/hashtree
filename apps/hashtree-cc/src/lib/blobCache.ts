// In-memory cache for locally uploaded blobs
// Viewer checks here first before fetching from Blossom
const cache = new Map<string, { data: Uint8Array; type: string }>();

export function cacheBlob(hashHex: string, data: Uint8Array, type: string) {
  cache.set(hashHex, { data, type });
}

export function getCachedBlob(hashHex: string): { data: Uint8Array; type: string } | undefined {
  return cache.get(hashHex);
}
