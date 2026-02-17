/// <reference lib="webworker" />

import { nhashEncode } from '@hashtree/core';
import type { WorkerRequest, WorkerResponse, WorkerConfig } from './protocol.js';
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
      if (req.upload !== false) {
        void blossom.upload(hashHex, req.data, req.mimeType).catch(() => {});
      }
      respond({
        type: 'blobStored',
        id: req.id,
        hashHex,
        nhash: nhashEncode(hashHex),
      });
      return;
    }

    case 'getBlob': {
      if (!storage || !blossom) {
        respond({ type: 'blob', id: req.id, error: 'Worker not initialized' });
        return;
      }
      const cached = await storage.get(req.hashHex);
      if (cached) {
        respond({ type: 'blob', id: req.id, data: cached, source: 'idb' });
        return;
      }
      const fetched = await blossom.fetch(req.hashHex);
      if (!fetched) {
        respond({ type: 'blob', id: req.id, error: 'Blob not found' });
        return;
      }
      await storage.putByHash(req.hashHex, fetched);
      respond({ type: 'blob', id: req.id, data: fetched, source: 'blossom' });
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
