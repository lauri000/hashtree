/// <reference lib="webworker" />

import { nhashDecode, nhashEncode, toHex } from '@hashtree/core';
import type {
  BlobSource,
  UploadProgressState,
  WorkerRequest,
  WorkerResponse,
  WorkerConfig,
} from './protocol.js';
import { IdbBlobStorage } from './capabilities/idbStorage.js';
import { BlossomTransport, DEFAULT_BLOSSOM_SERVERS } from './capabilities/blossomTransport.js';
import { probeConnectivity } from './capabilities/connectivity.js';

const DEFAULT_STORE_NAME = 'hashtree-worker';
const DEFAULT_STORAGE_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CONNECTIVITY_PROBE_INTERVAL_MS = 20_000;

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let storage: IdbBlobStorage | null = null;
let blossom: BlossomTransport | null = null;
let probeInterval: ReturnType<typeof setInterval> | null = null;
let probeIntervalMs = DEFAULT_CONNECTIVITY_PROBE_INTERVAL_MS;

interface MediaFileRequest {
  type: 'hashtree-file';
  requestId: string;
  nhash: string;
  path: string;
  start: number;
  end?: number;
  mimeType?: string;
  download?: boolean;
  head?: boolean;
}

interface MediaHeadersResponse {
  type: 'headers';
  requestId: string;
  status: number;
  totalSize: number;
  headers: Record<string, string>;
}

interface MediaChunkResponse {
  type: 'chunk';
  requestId: string;
  data: Uint8Array;
}

interface MediaDoneResponse {
  type: 'done';
  requestId: string;
}

interface MediaErrorResponse {
  type: 'error';
  requestId: string;
  message: string;
}

const MEDIA_CHUNK_SIZE = 64 * 1024;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function respond(message: WorkerResponse): void {
  ctx.postMessage(message);
}

function resetState(): void {
  if (probeInterval) {
    clearInterval(probeInterval);
    probeInterval = null;
  }
  storage?.close();
  storage = null;
  blossom = null;
}

async function emitConnectivityUpdate(): Promise<void> {
  if (!blossom) return;
  const state = await probeConnectivity(blossom.getServers());
  respond({ type: 'connectivityUpdate', state });
}

function startConnectivityProbeLoop(): void {
  if (probeInterval) {
    clearInterval(probeInterval);
    probeInterval = null;
  }
  probeInterval = setInterval(() => {
    void emitConnectivityUpdate();
  }, probeIntervalMs);
}

async function loadBlobData(hashHex: string): Promise<{ data: Uint8Array; source: BlobSource } | null> {
  if (!storage || !blossom) return null;
  const cached = await storage.get(hashHex);
  if (cached) {
    return { data: cached, source: 'idb' };
  }
  const fetched = await blossom.fetch(hashHex);
  if (!fetched) {
    return null;
  }
  await storage.putByHash(hashHex, fetched);
  return { data: fetched, source: 'blossom' };
}

function decodeDownloadName(path: string): string {
  try {
    return decodeURIComponent(path.split('/').pop() || 'file');
  } catch {
    return path.split('/').pop() || 'file';
  }
}

function postMediaError(port: MessagePort, requestId: string, message: string): void {
  const response: MediaErrorResponse = { type: 'error', requestId, message };
  port.postMessage(response);
}

async function handleMediaFileRequest(port: MessagePort, request: MediaFileRequest): Promise<void> {
  if (!storage || !blossom) {
    postMediaError(port, request.requestId, 'Worker not initialized');
    return;
  }

  let hashHex = '';
  try {
    hashHex = toHex(nhashDecode(request.nhash).hash);
  } catch {
    postMediaError(port, request.requestId, 'Invalid nhash');
    return;
  }

  const loaded = await loadBlobData(hashHex);
  if (!loaded) {
    postMediaError(port, request.requestId, 'Blob not found');
    return;
  }

  const totalSize = loaded.data.byteLength;
  let start = Number.isFinite(request.start) ? Math.max(0, Math.floor(request.start)) : 0;
  if (start >= totalSize) {
    const headers: MediaHeadersResponse = {
      type: 'headers',
      requestId: request.requestId,
      status: 416,
      totalSize,
      headers: {
        'content-type': request.mimeType || 'application/octet-stream',
        'content-range': `bytes */${totalSize}`,
      },
    };
    port.postMessage(headers);
    const done: MediaDoneResponse = { type: 'done', requestId: request.requestId };
    port.postMessage(done);
    return;
  }

  const requestedEnd = Number.isFinite(request.end) && typeof request.end === 'number'
    ? Math.floor(request.end)
    : totalSize - 1;
  const end = Math.min(totalSize - 1, Math.max(start, requestedEnd));
  const isPartial = start !== 0 || end !== totalSize - 1;
  const slice = loaded.data.subarray(start, end + 1);

  const responseHeaders: Record<string, string> = {
    'content-type': request.mimeType || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(slice.byteLength),
  };
  if (isPartial) {
    responseHeaders['content-range'] = `bytes ${start}-${end}/${totalSize}`;
  }
  if (request.download) {
    const fileName = decodeDownloadName(request.path).replace(/["\\]/g, '_');
    responseHeaders['content-disposition'] = `attachment; filename="${fileName}"`;
  }

  const headersMessage: MediaHeadersResponse = {
    type: 'headers',
    requestId: request.requestId,
    status: isPartial ? 206 : 200,
    totalSize,
    headers: responseHeaders,
  };
  port.postMessage(headersMessage);

  if (!request.head) {
    for (let offset = 0; offset < slice.byteLength; offset += MEDIA_CHUNK_SIZE) {
      const chunk = slice.subarray(offset, Math.min(offset + MEDIA_CHUNK_SIZE, slice.byteLength));
      const chunkMessage: MediaChunkResponse = {
        type: 'chunk',
        requestId: request.requestId,
        data: chunk,
      };
      port.postMessage(chunkMessage);
    }
  }

  const doneMessage: MediaDoneResponse = { type: 'done', requestId: request.requestId };
  port.postMessage(doneMessage);
}

function registerMediaPort(port: MessagePort): void {
  port.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<MediaFileRequest> | null;
    if (!data || data.type !== 'hashtree-file' || typeof data.requestId !== 'string') {
      return;
    }
    if (typeof data.nhash !== 'string' || typeof data.path !== 'string') {
      postMediaError(port, data.requestId, 'Invalid media request');
      return;
    }
    const request: MediaFileRequest = {
      type: 'hashtree-file',
      requestId: data.requestId,
      nhash: data.nhash,
      path: data.path,
      start: typeof data.start === 'number' ? data.start : 0,
      end: typeof data.end === 'number' ? data.end : undefined,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
      download: !!data.download,
      head: !!data.head,
    };
    void handleMediaFileRequest(port, request).catch((err) => {
      postMediaError(port, request.requestId, getErrorMessage(err));
    });
  };
}

function init(config: WorkerConfig): void {
  resetState();
  const storeName = config.storeName || DEFAULT_STORE_NAME;
  const maxBytes = config.storageMaxBytes || DEFAULT_STORAGE_MAX_BYTES;
  probeIntervalMs = config.connectivityProbeIntervalMs || DEFAULT_CONNECTIVITY_PROBE_INTERVAL_MS;

  storage = new IdbBlobStorage(storeName, maxBytes);
  blossom = new BlossomTransport(config.blossomServers || DEFAULT_BLOSSOM_SERVERS);

  startConnectivityProbeLoop();
  void emitConnectivityUpdate();
}

async function handleRequest(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case 'init': {
      init(req.config);
      respond({ type: 'ready', id: req.id });
      return;
    }

    case 'close': {
      resetState();
      respond({ type: 'void', id: req.id });
      return;
    }

    case 'putBlob': {
      if (!storage || !blossom) {
        respond({ type: 'error', id: req.id, error: 'Worker not initialized' });
        return;
      }
      const hashHex = await storage.put(req.data);
      const nhash = nhashEncode(hashHex);
      if (req.upload !== false) {
        const writeServers = blossom.getServers().filter(server => server.write);
        if (writeServers.length > 0) {
          const processedServers = new Set<string>();
          const progress: UploadProgressState = {
            hashHex,
            nhash,
            totalServers: writeServers.length,
            processedServers: 0,
            uploadedServers: 0,
            skippedServers: 0,
            failedServers: 0,
            complete: false,
          };

          respond({ type: 'uploadProgress', progress: { ...progress } });

          const onUploadProgress = (serverUrl: string, status: 'uploaded' | 'skipped' | 'failed'): void => {
            if (processedServers.has(serverUrl)) return;
            processedServers.add(serverUrl);

            switch (status) {
              case 'uploaded':
                progress.uploadedServers++;
                break;
              case 'skipped':
                progress.skippedServers++;
                break;
              case 'failed':
                progress.failedServers++;
                break;
            }

            progress.processedServers = processedServers.size;
            progress.complete = progress.processedServers >= progress.totalServers;
            respond({ type: 'uploadProgress', progress: { ...progress } });
          };

          void blossom.upload(hashHex, req.data, req.mimeType, onUploadProgress).catch((err) => {
            if (progress.complete) return;
            const remaining = progress.totalServers - progress.processedServers;
            if (remaining > 0) {
              progress.failedServers += remaining;
            }
            progress.processedServers = progress.totalServers;
            progress.complete = true;
            progress.error = getErrorMessage(err);
            respond({ type: 'uploadProgress', progress: { ...progress } });
          });
        }
      }
      respond({
        type: 'blobStored',
        id: req.id,
        hashHex,
        nhash,
      });
      return;
    }

    case 'getBlob': {
      if (!storage || !blossom) {
        respond({ type: 'blob', id: req.id, error: 'Worker not initialized' });
        return;
      }
      const loaded = await loadBlobData(req.hashHex);
      if (!loaded) {
        respond({ type: 'blob', id: req.id, error: 'Blob not found' });
        return;
      }
      respond({ type: 'blob', id: req.id, data: loaded.data, source: loaded.source });
      return;
    }

    case 'registerMediaPort': {
      if (!storage || !blossom) {
        respond({ type: 'void', id: req.id, error: 'Worker not initialized' });
        return;
      }
      registerMediaPort(req.port);
      respond({ type: 'void', id: req.id });
      return;
    }

    case 'setBlossomServers': {
      if (!blossom) {
        respond({ type: 'void', id: req.id, error: 'Worker not initialized' });
        return;
      }
      blossom.setServers(req.servers);
      respond({ type: 'void', id: req.id });
      void emitConnectivityUpdate();
      return;
    }

    case 'setStorageMaxBytes': {
      if (!storage) {
        respond({ type: 'void', id: req.id, error: 'Worker not initialized' });
        return;
      }
      storage.setMaxBytes(req.maxBytes);
      respond({ type: 'void', id: req.id });
      return;
    }

    case 'getStorageStats': {
      if (!storage) {
        respond({
          type: 'storageStats',
          id: req.id,
          items: 0,
          bytes: 0,
          maxBytes: 0,
          error: 'Worker not initialized',
        });
        return;
      }
      const stats = await storage.getStats();
      respond({ type: 'storageStats', id: req.id, ...stats });
      return;
    }

    case 'probeConnectivity': {
      if (!blossom) {
        respond({ type: 'connectivity', id: req.id, error: 'Worker not initialized' });
        return;
      }
      const state = await probeConnectivity(blossom.getServers());
      respond({ type: 'connectivity', id: req.id, state });
      return;
    }
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  void handleRequest(req).catch((err) => {
    respond({ type: 'error', id: req.id, error: getErrorMessage(err) });
  });
};
