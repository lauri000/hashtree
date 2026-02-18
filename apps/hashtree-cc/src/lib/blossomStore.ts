import {
  appendPutBlobStream,
  beginPutBlobStream,
  cancelPutBlobStream,
  finishPutBlobStream,
  getBlob,
  putBlob,
} from './workerClient';
import { getFromP2P } from './p2p';
import {
  beginLocalSaveProgress,
  endLocalSaveProgress,
  setLocalSavePhase,
  updateLocalSaveProgress,
} from './localSaveProgress';

/**
 * Store data in local worker cache and upload to configured Blossom servers in background.
 * Returns the nhash-based URL fragment.
 */
export async function uploadBuffer(data: Uint8Array, fileName: string, mimeType: string): Promise<string> {
  beginLocalSaveProgress(data.length);
  setLocalSavePhase('finalizing');
  updateLocalSaveProgress(data.length);
  try {
    const { nhash } = await putBlob(data, mimeType);
    const fragment = `/${nhash}/${encodeURIComponent(fileName)}`;
    window.location.hash = fragment;
    return fragment;
  } finally {
    endLocalSaveProgress();
  }
}

export async function uploadFileStream(file: File): Promise<string> {
  beginLocalSaveProgress(file.size);
  let streamId: string | null = null;
  let bytesSaved = 0;
  try {
    streamId = await beginPutBlobStream(file.type || 'application/octet-stream');
    const reader = file.stream().getReader();
    setLocalSavePhase('reading');
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      bytesSaved += chunk.byteLength;
      setLocalSavePhase('writing');
      await appendPutBlobStream(streamId, chunk);
      updateLocalSaveProgress(bytesSaved, file.size);
    }

    setLocalSavePhase('finalizing');
    updateLocalSaveProgress(file.size, file.size);

    const { nhash } = await finishPutBlobStream(streamId);
    streamId = null;
    const fragment = `/${nhash}/${encodeURIComponent(file.name)}`;
    window.location.hash = fragment;
    return fragment;
  } catch (err) {
    if (streamId) {
      await cancelPutBlobStream(streamId).catch(() => {});
    }
    throw err;
  } finally {
    endLocalSaveProgress();
  }
}

export async function fetchBuffer(hashHex: string): Promise<Uint8Array> {
  const peerData = await getFromP2P(hashHex);
  if (peerData) {
    return peerData;
  }
  return getBlob(hashHex);
}
