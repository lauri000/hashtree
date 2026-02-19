/// <reference lib="webworker" />

import {
  HashTree,
  decryptChk,
  nhashDecode,
  nhashEncode,
  toHex,
  tryDecodeTreeNode,
  type CID,
  type Hash,
  type Store,
} from '@hashtree/core';
import type {
  BlossomBandwidthState,
  BlobSource,
  UploadProgressState,
  UploadServerStatus,
  WorkerRequest,
  WorkerResponse,
  WorkerConfig,
} from './protocol.js';
import { IdbBlobStorage } from './capabilities/idbStorage.js';
import { BlossomTransport, DEFAULT_BLOSSOM_SERVERS } from './capabilities/blossomTransport.js';
import { probeConnectivity } from './capabilities/connectivity.js';
import { assertEncryptedUploadCid, markEncryptedHashes, shouldServeHashToPeer } from './privacyGuards.js';
import { streamFileRangeChunks } from './mediaStreaming.js';

const DEFAULT_STORE_NAME = 'hashtree-worker';
const DEFAULT_STORAGE_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CONNECTIVITY_PROBE_INTERVAL_MS = 20_000;
const P2P_FETCH_TIMEOUT_MS = 2_000;

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let storage: IdbBlobStorage | null = null;
let blossom: BlossomTransport | null = null;
let tree: HashTree | null = null;
let probeInterval: ReturnType<typeof setInterval> | null = null;
let probeIntervalMs = DEFAULT_CONNECTIVITY_PROBE_INTERVAL_MS;
let p2pFetchCounter = 0;
const pendingP2PFetches = new Map<
  string,
  { resolve: (data: Uint8Array | null) => void; timeoutId: ReturnType<typeof setTimeout> }
>();
const peerShareableEncryptedHashes = new Set<string>();
let putBlobStreamCounter = 0;
const activePutBlobStreams = new Map<string, {
  upload: boolean;
  writer: {
    append(data: Uint8Array): Promise<void>;
    finalize(): Promise<{ hash: Hash; size: number; key?: Uint8Array }>;
  };
}>();

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

const EMPTY_BLOSSOM_BANDWIDTH: BlossomBandwidthState = {
  totalBytesSent: 0,
  totalBytesReceived: 0,
  updatedAt: 0,
  servers: [],
};

let blossomBandwidth: BlossomBandwidthState = { ...EMPTY_BLOSSOM_BANDWIDTH };

function respond(message: WorkerResponse): void {
  ctx.postMessage(message);
}

function publishBlossomBandwidth(stats: BlossomBandwidthState): void {
  blossomBandwidth = {
    totalBytesSent: stats.totalBytesSent,
    totalBytesReceived: stats.totalBytesReceived,
    updatedAt: stats.updatedAt,
    servers: stats.servers.map(server => ({
      url: server.url,
      bytesSent: server.bytesSent,
      bytesReceived: server.bytesReceived,
    })),
  };

  respond({
    type: 'blossomBandwidth',
    stats: blossomBandwidth,
  });
}

function resetState(): void {
  if (probeInterval) {
    clearInterval(probeInterval);
    probeInterval = null;
  }
  storage?.close();
  storage = null;
  blossom = null;
  tree = null;
  for (const pending of pendingP2PFetches.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingP2PFetches.clear();
  peerShareableEncryptedHashes.clear();
  activePutBlobStreams.clear();
  blossomBandwidth = { ...EMPTY_BLOSSOM_BANDWIDTH };
}

async function markEncryptedTreeHashesAsPeerShareable(id: CID): Promise<void> {
  if (!tree) return;
  const hashes: string[] = [];
  for await (const block of tree.walkBlocks(id)) {
    hashes.push(toHex(block.hash));
  }
  markEncryptedHashes(hashes, peerShareableEncryptedHashes);
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

function nextP2PFetchRequestId(): string {
  p2pFetchCounter += 1;
  return `p2p_${Date.now()}_${p2pFetchCounter}`;
}

async function requestP2PBlob(hashHex: string): Promise<Uint8Array | null> {
  const requestId = nextP2PFetchRequestId();
  const data = await new Promise<Uint8Array | null>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingP2PFetches.delete(requestId);
      resolve(null);
    }, P2P_FETCH_TIMEOUT_MS);
    pendingP2PFetches.set(requestId, { resolve, timeoutId });
    respond({ type: 'p2pFetch', requestId, hashHex });
  });

  return data;
}

function resolveP2PFetch(requestId: string, data?: Uint8Array, error?: string): void {
  const pending = pendingP2PFetches.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingP2PFetches.delete(requestId);

  if (error || !data) {
    pending.resolve(null);
    return;
  }

  pending.resolve(data);
}

async function loadBlobData(hashHex: string): Promise<{ data: Uint8Array; source: BlobSource } | null> {
  if (!storage) return null;
  const cached = await storage.get(hashHex);
  if (cached) {
    return { data: cached, source: 'idb' };
  }
  if (blossom) {
    const fetched = await blossom.fetch(hashHex);
    if (fetched) {
      await storage.putByHash(hashHex, fetched);
      return { data: fetched, source: 'blossom' };
    }
  }

  const p2pData = await requestP2PBlob(hashHex);
  if (!p2pData) {
    return null;
  }

  try {
    await storage.putByHash(hashHex, p2pData);
  } catch {
    return null;
  }

  return { data: p2pData, source: 'p2p' };
}

function createWorkerStore(): Store {
  return {
    put: async (hash: Hash, data: Uint8Array): Promise<boolean> => {
      if (!storage) throw new Error('Worker storage not initialized');
      await storage.putByHashTrusted(toHex(hash), data);
      return true;
    },
    get: async (hash: Hash): Promise<Uint8Array | null> => {
      const loaded = await loadBlobData(toHex(hash));
      return loaded?.data ?? null;
    },
    has: async (hash: Hash): Promise<boolean> => {
      if (!storage) return false;
      return storage.has(toHex(hash));
    },
    delete: async (hash: Hash): Promise<boolean> => {
      if (!storage) return false;
      return storage.delete(toHex(hash));
    },
  };
}

async function getPlaintextFileSize(fileCid: CID): Promise<number | null> {
  if (!tree) return null;

  if (!fileCid.key) {
    return tree.getSize(fileCid.hash);
  }

  const loaded = await loadBlobData(toHex(fileCid.hash));
  if (!loaded) return null;

  const decryptedRoot = await decryptChk(loaded.data, fileCid.key);
  const rootNode = tryDecodeTreeNode(decryptedRoot);
  if (!rootNode) {
    return decryptedRoot.byteLength;
  }

  const summedSize = rootNode.links.reduce((sum, link) => sum + (link.size ?? 0), 0);
  if (summedSize > 0) {
    return summedSize;
  }

  const fullData = await tree.readFile(fileCid);
  return fullData?.byteLength ?? 0;
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
  if (!tree) {
    postMediaError(port, request.requestId, 'Worker not initialized');
    return;
  }

  let cid: CID;
  try {
    cid = nhashDecode(request.nhash);
  } catch {
    postMediaError(port, request.requestId, 'Invalid nhash');
    return;
  }

  const totalSize = await getPlaintextFileSize(cid);
  if (totalSize === null) {
    postMediaError(port, request.requestId, 'File not found');
    return;
  }

  if (totalSize === 0) {
    const headersMessage: MediaHeadersResponse = {
      type: 'headers',
      requestId: request.requestId,
      status: 200,
      totalSize,
      headers: {
        'content-type': request.mimeType || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': '0',
      },
    };
    port.postMessage(headersMessage);
    const doneMessage: MediaDoneResponse = { type: 'done', requestId: request.requestId };
    port.postMessage(doneMessage);
    return;
  }

  const start = Number.isFinite(request.start) ? Math.max(0, Math.floor(request.start)) : 0;
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

  const expectedLength = end - start + 1;

  const responseHeaders: Record<string, string> = {
    'content-type': request.mimeType || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(expectedLength),
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
    for await (const chunk of streamFileRangeChunks(tree, cid, start, end, MEDIA_CHUNK_SIZE)) {
      const chunkMessage: MediaChunkResponse = {
        type: 'chunk',
        requestId: request.requestId,
        data: chunk,
      };
      port.postMessage(chunkMessage, [chunk.buffer]);
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
  blossom = new BlossomTransport(
    config.blossomServers || DEFAULT_BLOSSOM_SERVERS,
    (stats) => {
      publishBlossomBandwidth(stats);
    }
  );
  tree = new HashTree({ store: createWorkerStore() });
  publishBlossomBandwidth(blossom.getBandwidthStats());

  startConnectivityProbeLoop();
  void emitConnectivityUpdate();
}

function nextPutBlobStreamId(): string {
  putBlobStreamCounter += 1;
  return `pbs_${Date.now()}_${putBlobStreamCounter}`;
}

function startBlossomUploadProgress(hashHex: string, nhash: string, fileCid: CID): void {
  if (!blossom || !tree) return;
  const writeServers = blossom.getWriteServers();
  if (writeServers.length === 0) return;
  const chunkProgressEmitIntervalMs = 100;

  const progress: UploadProgressState = {
    hashHex,
    nhash,
    totalServers: writeServers.length,
    processedServers: 0,
    uploadedServers: 0,
    skippedServers: 0,
    failedServers: 0,
    totalChunks: 0,
    processedChunks: 0,
    progressRatio: 0,
    complete: false,
  };

  const serverStats = new Map<string, UploadServerStatus>();
  for (const server of writeServers) {
    serverStats.set(server.url, { url: server.url, uploaded: 0, skipped: 0, failed: 0 });
  }

  let lastChunkProgressEmit = 0;

  const syncServerStatuses = (): void => {
    progress.serverStatuses = Array.from(serverStats.values())
      .map((status) => ({ ...status }))
      .sort((a, b) => a.url.localeCompare(b.url));
  };

  const emitProgress = (): void => {
    syncServerStatuses();
    respond({ type: 'uploadProgress', progress: { ...progress } });
  };

  emitProgress();

  const onUploadProgress = (serverUrl: string, status: 'uploaded' | 'skipped' | 'failed'): void => {
    const stats = serverStats.get(serverUrl);
    if (!stats) return;
    stats[status]++;
  };

  void (async () => {
    const uploadStore = blossom.createUploadStore(onUploadProgress);
    const result = await tree.push(fileCid, uploadStore, {
      onProgress: (current, total) => {
        if (total <= 0 || progress.complete) return;
        const fraction = current / total;
        progress.totalChunks = total;
        progress.processedChunks = current;
        progress.progressRatio = Math.max(0, Math.min(1, fraction));

        const processedEstimate = Math.min(
          progress.totalServers,
          Math.max(0, Math.floor(fraction * progress.totalServers))
        );
        const serverEstimateChanged = processedEstimate !== progress.processedServers;
        if (serverEstimateChanged) {
          progress.processedServers = processedEstimate;
        }

        const now = Date.now();
        const shouldEmitChunkProgress = now - lastChunkProgressEmit >= chunkProgressEmitIntervalMs || current >= total;
        if (serverEstimateChanged || shouldEmitChunkProgress) {
          lastChunkProgressEmit = now;
          emitProgress();
        }
      },
    });

    let uploadedServers = 0;
    let skippedServers = 0;
    let failedServers = 0;
    for (const [, stats] of serverStats) {
      if (stats.failed > 0) {
        failedServers++;
      } else if (stats.uploaded > 0) {
        uploadedServers++;
      } else {
        skippedServers++;
      }
    }

    progress.uploadedServers = uploadedServers;
    progress.skippedServers = skippedServers;
    progress.failedServers = failedServers;
    progress.processedServers = progress.totalServers;
    if (typeof progress.totalChunks === 'number' && progress.totalChunks > 0) {
      progress.processedChunks = progress.totalChunks;
    }
    progress.progressRatio = 1;
    progress.complete = true;
    if (result.failed > 0 && result.errors.length > 0) {
      progress.error = result.errors[0].error.message;
    }
    emitProgress();
  })().catch((err) => {
    if (progress.complete) return;
    progress.failedServers = progress.totalServers;
    progress.processedServers = progress.totalServers;
    if (typeof progress.totalChunks === 'number' && progress.totalChunks > 0) {
      progress.processedChunks = progress.totalChunks;
    }
    progress.progressRatio = 1;
    progress.complete = true;
    progress.error = getErrorMessage(err);
    emitProgress();
  });
}

function respondBlobStored(id: string, fileCid: CID, upload: boolean): void {
  const hashHex = toHex(fileCid.hash);
  const nhash = nhashEncode(fileCid);

  if (upload) {
    startBlossomUploadProgress(hashHex, nhash, fileCid);
  }

  respond({
    type: 'blobStored',
    id,
    hashHex,
    nhash,
  });
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
      if (!storage || !blossom || !tree) {
        respond({ type: 'error', id: req.id, error: 'Worker not initialized' });
        return;
      }

      let fileCid: CID;
      if (req.upload === false) {
        const hash = await tree.putBlob(req.data);
        fileCid = { hash };
      } else {
        const fileResult = await tree.putFile(req.data);
        fileCid = fileResult.cid;
        assertEncryptedUploadCid(fileCid);
        await markEncryptedTreeHashesAsPeerShareable(fileCid);
      }

      respondBlobStored(req.id, fileCid, req.upload !== false);
      return;
    }

    case 'beginPutBlobStream': {
      if (!tree) {
        respond({ type: 'error', id: req.id, error: 'Worker not initialized' });
        return;
      }
      const upload = req.upload !== false;
      const streamId = nextPutBlobStreamId();
      const writer = tree.createStream({ unencrypted: !upload });
      activePutBlobStreams.set(streamId, { upload, writer });
      respond({ type: 'blobStreamStarted', id: req.id, streamId });
      return;
    }

    case 'appendPutBlobStream': {
      const stream = activePutBlobStreams.get(req.streamId);
      if (!stream) {
        respond({ type: 'void', id: req.id, error: 'Upload stream not found' });
        return;
      }
      await stream.writer.append(req.chunk);
      respond({ type: 'void', id: req.id });
      return;
    }

    case 'finishPutBlobStream': {
      const stream = activePutBlobStreams.get(req.streamId);
      if (!stream) {
        respond({ type: 'error', id: req.id, error: 'Upload stream not found' });
        return;
      }
      activePutBlobStreams.delete(req.streamId);

      const finalized = await stream.writer.finalize();
      const fileCid: CID = finalized.key
        ? { hash: finalized.hash, key: finalized.key }
        : { hash: finalized.hash };

      if (stream.upload) {
        assertEncryptedUploadCid(fileCid);
        await markEncryptedTreeHashesAsPeerShareable(fileCid);
      }

      respondBlobStored(req.id, fileCid, stream.upload);
      return;
    }

    case 'cancelPutBlobStream': {
      activePutBlobStreams.delete(req.streamId);
      respond({ type: 'void', id: req.id });
      return;
    }

    case 'p2pFetchResult': {
      resolveP2PFetch(req.requestId, req.data, req.error);
      return;
    }

    case 'getBlob': {
      if (!storage) {
        respond({ type: 'blob', id: req.id, error: 'Worker not initialized' });
        return;
      }
      if (req.forPeer && !shouldServeHashToPeer(req.hashHex, peerShareableEncryptedHashes)) {
        respond({ type: 'blob', id: req.id, error: 'Refusing to serve non-encrypted or untrusted blob to peer' });
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
      if (!storage) {
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
