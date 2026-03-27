import type { BlossomServerConfig } from '@hashtree/worker';
import { DEFAULT_RELAYS as DEFAULT_NOSTR_RELAYS } from '@hashtree/nostr';
import HashtreeWorker from '@hashtree/worker/iris-entry?worker';

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PUBKEY_HEX = '336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b';
const DEFAULT_RELAYS = Array.from(new Set([...DEFAULT_NOSTR_RELAYS, 'wss://offchain.pub']));
const DEFAULT_BLOSSOM_SERVERS: BlossomServerConfig[] = [
  { url: 'https://cdn.iris.to', read: true, write: false },
  { url: 'https://upload.iris.to', read: false, write: true },
  { url: 'https://blossom.primal.net', read: true, write: true },
];

type IrisWorkerConfig = {
  storeName: string;
  blossomServers: BlossomServerConfig[];
  relays: string[];
  pubkey: string;
  nsec?: string;
};

type PendingRequest = {
  resolve: (message: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export interface TreeRootInfo {
  hash: Uint8Array;
  key?: Uint8Array;
  visibility: 'public' | 'link-visible' | 'private';
  labels?: string[];
  updatedAt: number;
  encryptedKey?: string;
  keyId?: string;
  selfEncryptedKey?: string;
  selfEncryptedLinkKey?: string;
}

export interface TreeRootUpdate extends TreeRootInfo {
  npub: string;
  treeName: string;
}

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
let initPending:
  | {
      id: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  | null = null;
const pendingRequests = new Map<string, PendingRequest>();
const treeRootListeners = new Set<(update: TreeRootUpdate) => void>();

function nextRequestId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function rejectPendingRequest(id: string, error: Error): void {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pending.reject(error);
  pendingRequests.delete(id);
}

function rejectAllPending(error: Error): void {
  for (const id of Array.from(pendingRequests.keys())) {
    rejectPendingRequest(id, error);
  }
  if (initPending) {
    clearTimeout(initPending.timeoutId);
    initPending.reject(error);
    initPending = null;
  }
  initPromise = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new HashtreeWorker();
  worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
    const message = event.data;

    if (message?.type === 'ready') {
      if (initPending) {
        clearTimeout(initPending.timeoutId);
        initPending.resolve();
        initPending = null;
      }
      return;
    }

    if (message?.type === 'treeRootUpdate') {
      const update = message as unknown as TreeRootUpdate;
      for (const listener of treeRootListeners) {
        listener(update);
      }
      return;
    }

    const messageId = typeof message?.id === 'string' ? message.id : null;
    if (message?.type === 'error' && messageId) {
      const errorMessage = typeof message.error === 'string' ? message.error : 'Worker error';
      if (initPending?.id === messageId) {
        clearTimeout(initPending.timeoutId);
        initPending.reject(new Error(errorMessage));
        initPending = null;
        initPromise = null;
        return;
      }
      rejectPendingRequest(messageId, new Error(errorMessage));
      return;
    }

    if (messageId && pendingRequests.has(messageId)) {
      const pending = pendingRequests.get(messageId);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      pending.resolve(message);
      pendingRequests.delete(messageId);
    }
  };

  worker.onerror = (event) => {
    const message = event instanceof ErrorEvent ? event.message : 'Worker error';
    rejectAllPending(new Error(message));
  };

  return worker;
}

async function ensureReady(): Promise<void> {
  if (initPromise) return initPromise;

  const targetWorker = ensureWorker();
  const config: IrisWorkerConfig = {
    storeName: 'iris-sites-worker',
    blossomServers: DEFAULT_BLOSSOM_SERVERS,
    relays: DEFAULT_RELAYS,
    pubkey: DEFAULT_PUBKEY_HEX,
  };

  initPromise = new Promise<void>((resolve, reject) => {
    const id = nextRequestId('worker_init');
    const timeoutId = setTimeout(() => {
      if (initPending?.id === id) {
        initPending = null;
      }
      initPromise = null;
      reject(new Error('Worker init timed out'));
    }, REQUEST_TIMEOUT_MS);

    initPending = {
      id,
      resolve: () => resolve(),
      reject,
      timeoutId,
    };

    targetWorker.postMessage({
      type: 'init',
      id,
      config,
    });
  });

  return initPromise;
}

export async function initWorkerClient(): Promise<void> {
  await ensureReady();
}

export async function registerMediaPort(port: MessagePort): Promise<void> {
  await ensureReady();
  const targetWorker = ensureWorker();
  targetWorker.postMessage({
    type: 'registerMediaPort',
    id: nextRequestId('media_port'),
    port,
  }, [port]);
}

async function requestWorker(message: Record<string, unknown>, prefix: string): Promise<unknown> {
  await ensureReady();
  const targetWorker = ensureWorker();
  const id = nextRequestId(prefix);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`${prefix} timed out`));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, {
      resolve,
      reject,
      timeoutId,
    });

    targetWorker.postMessage({
      ...message,
      id,
    });
  });
}

export async function getTreeRootInfo(npub: string, treeName: string): Promise<TreeRootInfo | null> {
  const response = await requestWorker({
    type: 'getTreeRootInfo',
    npub,
    treeName,
  }, 'tree_root_info') as { type?: string; record?: TreeRootInfo; error?: string };

  if (response.type !== 'treeRootInfo') {
    throw new Error('Unexpected tree root response');
  }
  if (response.error) {
    throw new Error(response.error);
  }
  return response.record ?? null;
}

export async function subscribeTreeRoots(pubkey: string): Promise<void> {
  const response = await requestWorker({
    type: 'subscribeTreeRoots',
    pubkey,
  }, 'tree_root_subscribe') as { type?: string; error?: string };

  if (response.type !== 'void') {
    throw new Error('Unexpected tree root subscribe response');
  }
  if (response.error) {
    throw new Error(response.error);
  }
}

export async function unsubscribeTreeRoots(pubkey: string): Promise<void> {
  const response = await requestWorker({
    type: 'unsubscribeTreeRoots',
    pubkey,
  }, 'tree_root_unsubscribe') as { type?: string; error?: string };

  if (response.type !== 'void') {
    throw new Error('Unexpected tree root unsubscribe response');
  }
  if (response.error) {
    throw new Error(response.error);
  }
}

export function onTreeRootUpdate(listener: (update: TreeRootUpdate) => void): () => void {
  treeRootListeners.add(listener);
  return () => {
    treeRootListeners.delete(listener);
  };
}
