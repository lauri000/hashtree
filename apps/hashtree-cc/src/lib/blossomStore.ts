import { getBlob, putBlob } from './workerClient';
import { getFromP2P } from './p2p';

/**
 * Store data in local worker cache and upload to configured Blossom servers in background.
 * Returns the nhash-based URL fragment.
 */
export async function uploadBuffer(data: Uint8Array, fileName: string, mimeType: string): Promise<string> {
  const { nhash } = await putBlob(data, mimeType);
  const fragment = `/${nhash}/${encodeURIComponent(fileName)}`;
  window.location.hash = fragment;
  return fragment;
}

export async function fetchBuffer(hashHex: string): Promise<Uint8Array> {
  const peerData = await getFromP2P(hashHex);
  if (peerData) {
    return peerData;
  }
  return getBlob(hashHex);
}
