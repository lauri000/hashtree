import { HashtreeWorkerClient } from '@hashtree/worker';
import type { ConnectivityState } from '@hashtree/worker';
import type { UploadProgressState } from '@hashtree/worker';
import type { P2PFetchHandler } from '@hashtree/worker';
import { writable } from 'svelte/store';
import HashtreeWorker from '@hashtree/worker/entry?worker';
import { settingsStore } from './settings';

const DEFAULT_CONNECTIVITY: ConnectivityState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  reachableReadServers: 0,
  totalReadServers: 0,
  reachableWriteServers: 0,
  totalWriteServers: 0,
  updatedAt: Date.now(),
};

const CONNECTIVITY_POLL_INTERVAL_MS = 15_000;

export const connectivityStore = writable<ConnectivityState>(DEFAULT_CONNECTIVITY);
export const uploadProgressStore = writable<UploadProgressState | null>(null);

let client: HashtreeWorkerClient | null = null;
let initPromise: Promise<HashtreeWorkerClient> | null = null;
let settingsUnsubscribe: (() => void) | null = null;
let connectivityUnsubscribe: (() => void) | null = null;
let uploadProgressUnsubscribe: (() => void) | null = null;
let connectivityTimer: ReturnType<typeof setInterval> | null = null;
let clearUploadProgressTimer: ReturnType<typeof setTimeout> | null = null;
let p2pFetchHandler: P2PFetchHandler | null = null;

async function probeConnectivity(clientInstance: HashtreeWorkerClient): Promise<void> {
  try {
    const state = await clientInstance.probeConnectivity();
    connectivityStore.set(state);
  } catch {
    // Ignore probe errors, worker will retry.
  }
}

function syncSettingsToWorker(clientInstance: HashtreeWorkerClient): void {
  if (settingsUnsubscribe) return;
  settingsUnsubscribe = settingsStore.subscribe((settings) => {
    void clientInstance.setBlossomServers(settings.network.blossomServers).catch(() => {});
    void clientInstance.setStorageMaxBytes(settings.storage.maxBytes).catch(() => {});
  });
}

function startConnectivityPolling(clientInstance: HashtreeWorkerClient): void {
  if (connectivityUnsubscribe) return;
  connectivityUnsubscribe = clientInstance.onConnectivityUpdate((state) => {
    connectivityStore.set(state);
  });

  if (!connectivityTimer) {
    void probeConnectivity(clientInstance);
    connectivityTimer = setInterval(() => {
      void probeConnectivity(clientInstance);
    }, CONNECTIVITY_POLL_INTERVAL_MS);
  }
}

function startUploadProgressUpdates(clientInstance: HashtreeWorkerClient): void {
  if (uploadProgressUnsubscribe) return;
  uploadProgressUnsubscribe = clientInstance.onUploadProgress((progress) => {
    uploadProgressStore.set(progress);

    if (clearUploadProgressTimer) {
      clearTimeout(clearUploadProgressTimer);
      clearUploadProgressTimer = null;
    }

    if (progress.complete) {
      clearUploadProgressTimer = setTimeout(() => {
        uploadProgressStore.update((current) => {
          if (!current) return current;
          return current.hashHex === progress.hashHex && current.complete ? null : current;
        });
      }, 3000);
    }
  });
}

async function ensureClient(): Promise<HashtreeWorkerClient> {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const settings = settingsStore.getState();
    const created = new HashtreeWorkerClient(HashtreeWorker, {
      storeName: 'hashtree-cc-worker',
      blossomServers: settings.network.blossomServers,
      storageMaxBytes: settings.storage.maxBytes,
      connectivityProbeIntervalMs: CONNECTIVITY_POLL_INTERVAL_MS,
    });
    created.setP2PFetchHandler(p2pFetchHandler);
    await created.init();
    syncSettingsToWorker(created);
    startConnectivityPolling(created);
    startUploadProgressUpdates(created);
    client = created;
    return created;
  })();

  return initPromise;
}

export async function initWorkerClient(): Promise<void> {
  await ensureClient();
}

export async function getWorkerClient(): Promise<HashtreeWorkerClient> {
  return ensureClient();
}

export async function putBlob(
  data: Uint8Array,
  mimeType?: string,
  upload = true
): Promise<{ hashHex: string; nhash: string }> {
  const worker = await ensureClient();
  return worker.putBlob(data, mimeType, upload);
}

export async function getBlob(hashHex: string): Promise<Uint8Array> {
  const worker = await ensureClient();
  const { data } = await worker.getBlob(hashHex);
  return data;
}

export async function getStorageStats(): Promise<{ items: number; bytes: number; maxBytes: number }> {
  const worker = await ensureClient();
  return worker.getStorageStats();
}

export async function registerMediaPort(port: MessagePort): Promise<void> {
  const worker = await ensureClient();
  await worker.registerMediaPort(port);
}

export function setP2PFetchHandler(handler: P2PFetchHandler | null): void {
  p2pFetchHandler = handler;
  client?.setP2PFetchHandler(handler);
}
