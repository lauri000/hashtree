import { streamUploadWithProgress } from '@hashtree/core';
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
  beginLocalSaveProgressForFile,
  endLocalSaveProgress,
  setLocalSavePhase,
  updateLocalSaveProgress,
} from './localSaveProgress';

const STREAM_APPEND_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * Store data in local worker cache and upload to configured Blossom servers in background.
 * Returns the nhash-based URL fragment.
 */
export async function uploadBuffer(data: Uint8Array, fileName: string, mimeType: string): Promise<string> {
  beginLocalSaveProgressForFile(data.length, fileName);
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
  beginLocalSaveProgressForFile(file.size, file.name);
  let streamId: string | null = null;
  try {
    streamId = await beginPutBlobStream(file.type || 'application/octet-stream');

    const result = await streamUploadWithProgress(
      file,
      {
        append: async (chunk: Uint8Array) => {
          if (!streamId) throw new Error('Upload stream not initialized');
          await appendPutBlobStream(streamId, chunk);
        },
        finalize: async () => {
          if (!streamId) throw new Error('Upload stream not initialized');
          return finishPutBlobStream(streamId);
        },
      },
      {
        batchBytes: STREAM_APPEND_BATCH_BYTES,
        onProgress: (progress) => {
          setLocalSavePhase(progress.phase);
          updateLocalSaveProgress(progress.bytesProcessed, progress.totalBytes);
        },
      }
    );

    const { nhash } = result;
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
