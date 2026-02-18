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

const STREAM_APPEND_BATCH_BYTES = 2 * 1024 * 1024;

function coalesceChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

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
  let bufferedChunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  try {
    streamId = await beginPutBlobStream(file.type || 'application/octet-stream');

    const flushBufferedChunks = async (): Promise<void> => {
      if (!streamId || bufferedBytes === 0) return;
      setLocalSavePhase('writing');
      const batch = coalesceChunks(bufferedChunks, bufferedBytes);
      bufferedChunks = [];
      bufferedBytes = 0;
      await appendPutBlobStream(streamId, batch);
      bytesSaved += batch.byteLength;
      updateLocalSaveProgress(bytesSaved, file.size);
    };

    const reader = file.stream().getReader();
    while (true) {
      setLocalSavePhase('reading');
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      bufferedChunks.push(chunk);
      bufferedBytes += chunk.byteLength;
      updateLocalSaveProgress(Math.min(file.size, bytesSaved + bufferedBytes), file.size);

      if (bufferedBytes >= STREAM_APPEND_BATCH_BYTES) {
        await flushBufferedChunks();
      }
    }

    await flushBufferedChunks();
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
