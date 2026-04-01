/**
 * Tree root store for Svelte
 *
 * This provides the rootCid from the URL via resolver subscription:
 * - For tree routes (/npub/treeName/...), subscribes to the resolver
 * - For permalink routes (/nhash1.../...), extracts hash directly from URL
 * - Returns null when no tree context
 *
 * Data flow:
 * - Local writes -> TreeRootRegistry (via treeRootCache.ts)
 * - Web: worker tree-root events -> TreeRootRegistry (via setFromWorker)
 * - Tauri: resolver events -> TreeRootRegistry (via setFromResolver)
 * - UI reads -> TreeRootRegistry (via get/resolve)
 */
import { writable, get, type Readable } from 'svelte/store';
import { fromHex, toHex, cid, visibilityHex } from '@hashtree/core';
import type {
  CID,
  SubscribeVisibilityInfo,
  Hash,
  TreeVisibility,
  RefResolverSubscriptionMetadata,
} from '@hashtree/core';
import { routeStore, parseRouteFromHash } from './route';
import { getRefResolver, getResolverKey } from '../refResolver';
import { nostrStore, decrypt, type NostrState } from '../nostr';
import { npubToPubkey } from '../nostr/trees';
import { logHtreeDebug } from '../lib/htreeDebug';
import { syncNativeTreeRootCache } from '../lib/nativeTreeRootCache';
import {
  getTreeRootSubscriptionPlan,
  shouldStartTreeRootSubscription,
} from '../lib/treeRootSubscriptionPlan';
import { shouldWaitForLinkVisibleMetadata } from '../lib/treeRootRoutePolicy';
import { treeRootRegistry } from '../TreeRootRegistry';
import type { TreeRootRecord } from '../TreeRootRegistry';
import { permalinkSnapshotStore, getPermalinkSnapshotSync, isSnapshotPermalinkSync } from './permalinkSnapshot';

// Wait for worker to be ready before creating subscriptions
// This ensures the NDK transport plugin is registered
let workerReadyPromise: Promise<void> | null = null;
let workerReadyResolve: (() => void) | null = null;
const WORKER_READY_TIMEOUT_MS = 10000;

/**
 * Signal that the worker is ready (called from auth.ts after initHashtreeWorker)
 */
export function signalWorkerReady(): void {
  if (workerReadyResolve) {
    workerReadyResolve();
    workerReadyResolve = null;
  }
  logHtreeDebug('worker:ready');
}

/**
 * Wait for the worker to be ready
 */
function waitForWorkerReady(): Promise<void> {
  if (!workerReadyPromise) {
    workerReadyPromise = new Promise((resolve) => {
      // Check if worker is already ready (import dynamically to avoid circular deps)
      import('../lib/workerInit').then(({ isWorkerReady }) => {
        if (isWorkerReady()) {
          resolve();
        } else {
          workerReadyResolve = resolve;
        }
      });
    });
  }
  return workerReadyPromise;
}

// Subscription state - manages resolver subscriptions and listeners
// The actual data is stored in TreeRootRegistry
const subscriptionState = new Map<string, {
  decryptedKey: Hash | undefined;
  listeners: Set<(
    hash: Hash | null,
    encryptionKey?: Hash,
    visibilityInfo?: SubscribeVisibilityInfo,
    metadata?: RefResolverSubscriptionMetadata
  ) => void>;
  unsubscribeResolver: (() => void) | null;
  unsubscribeWorker: (() => void) | null;
  workerHydrateRetryTimer: ReturnType<typeof setTimeout> | null;
}>();

type ResolverListVisibilityEntry = {
  visibility?: string;
  selfEncryptedLinkKey?: string;
  encryptedKey?: string;
  selfEncryptedKey?: string;
};

function getNostrState(): NostrState {
  return get(nostrStore) as NostrState;
}

/**
 * Build SubscribeVisibilityInfo from registry record
 */
function getVisibilityInfoFromRegistry(key: string): SubscribeVisibilityInfo | undefined {
  const record = treeRootRegistry.getByKey(key);
  if (!record) return undefined;
  return {
    visibility: record.visibility,
    encryptedKey: record.encryptedKey,
    keyId: record.keyId,
    selfEncryptedKey: record.selfEncryptedKey,
    selfEncryptedLinkKey: record.selfEncryptedLinkKey,
  };
}

const workerKeyMergeCache = new Map<string, string>();
const workerRootCacheSync = new Map<string, string>();

function getWorkerRootSignature(record: TreeRootRecord): string {
  const labels = record.labels?.join(',') ?? '';
  return `${toHex(record.hash)}:${record.key ? toHex(record.key) : ''}:${record.visibility}:${labels}`;
}

async function syncResolvedTreeRootToWorker(key: string, record: TreeRootRecord): Promise<void> {
  if (record.source !== 'nostr' && record.source !== 'prefetch') return;

  const signature = getWorkerRootSignature(record);
  if (workerRootCacheSync.get(key) === signature) return;

  const slashIndex = key.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= key.length - 1) return;

  const npub = key.slice(0, slashIndex);
  const treeName = key.slice(slashIndex + 1);

  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(2000);
    if (!adapter || !('setTreeRootCache' in adapter)) return;

    await (adapter as {
      setTreeRootCache: (
        npub: string,
        treeName: string,
        hash: Hash,
        key?: Hash,
        visibility?: TreeVisibility,
        labels?: string[],
        metadata?: {
          encryptedKey?: string;
          keyId?: string;
          selfEncryptedKey?: string;
          selfEncryptedLinkKey?: string;
        }
      ) => Promise<void>;
    }).setTreeRootCache(npub, treeName, record.hash, record.key, record.visibility, record.labels, {
      encryptedKey: record.encryptedKey,
      keyId: record.keyId,
      selfEncryptedKey: record.selfEncryptedKey,
      selfEncryptedLinkKey: record.selfEncryptedLinkKey,
    });

    workerRootCacheSync.set(key, signature);
  } catch (err) {
    console.warn('[treeRoot] Failed to sync resolved tree root to worker:', err);
  }
}

async function mergeTreeRootKeyToWorker(
  npub: string,
  treeName: string,
  hash: Hash,
  key: Hash
): Promise<boolean> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
    if (!adapter || !('mergeTreeRootKey' in adapter)) return false;
    return await adapter.mergeTreeRootKey(npub, treeName, hash, key);
  } catch (err) {
    console.warn('[treeRoot] Failed to merge tree root key in worker:', err);
    return false;
  }
}

async function ensureWorkerTreeRootSubscription(npub: string): Promise<boolean> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(2000);
    if (!adapter || !('subscribeTreeRoots' in adapter)) return false;

    const pubkey = npubToPubkey(npub) ?? npub;
    await adapter.subscribeTreeRoots(pubkey);
    return true;
  } catch (err) {
    console.warn('[treeRoot] Failed to subscribe worker to tree roots:', err);
    return false;
  }
}

async function unsubscribeWorkerTreeRootSubscription(npub: string): Promise<void> {
  try {
    const { getWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter();
    if (!adapter || !('unsubscribeTreeRoots' in adapter)) return;

    const pubkey = npubToPubkey(npub) ?? npub;
    await adapter.unsubscribeTreeRoots(pubkey);
  } catch (err) {
    console.warn('[treeRoot] Failed to unsubscribe worker from tree roots:', err);
  }
}

async function hydrateTreeRootFromWorker(npub: string, treeName: string): Promise<boolean> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(2000);
    if (!adapter || !('getTreeRootInfo' in adapter)) return false;

    const record = await adapter.getTreeRootInfo(npub, treeName);
    if (!record) return false;

    treeRootRegistry.setFromWorker(npub, treeName, record.hash, record.updatedAt, {
      key: record.key,
      visibility: record.visibility,
      labels: record.labels,
      encryptedKey: record.encryptedKey,
      keyId: record.keyId,
      selfEncryptedKey: record.selfEncryptedKey,
      selfEncryptedLinkKey: record.selfEncryptedLinkKey,
    });
    return true;
  } catch (err) {
    console.warn('[treeRoot] Failed to hydrate tree root from worker:', err);
    return false;
  }
}

const WORKER_HYDRATE_RETRY_DELAYS_MS = [250, 1000, 2500, 5000];

function clearWorkerHydrateRetry(key: string): void {
  const state = subscriptionState.get(key);
  if (!state?.workerHydrateRetryTimer) return;
  clearTimeout(state.workerHydrateRetryTimer);
  state.workerHydrateRetryTimer = null;
}

function scheduleWorkerHydrateRetry(
  key: string,
  npub: string,
  treeName: string,
  options?: { skipWorkerHydrate?: boolean },
  attempt: number = 0
): void {
  if (options?.skipWorkerHydrate) return;
  const delay = WORKER_HYDRATE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;

  const state = subscriptionState.get(key);
  if (!state) return;
  clearWorkerHydrateRetry(key);

  state.workerHydrateRetryTimer = setTimeout(() => {
    const active = subscriptionState.get(key);
    if (!active) return;

    active.workerHydrateRetryTimer = null;

    void hydrateTreeRootFromWorker(npub, treeName).then((hydrated) => {
      if (hydrated) {
        logHtreeDebug('treeRoot:hydrate-retry', { resolverKey: key, attempt: attempt + 1 });
        return;
      }
      scheduleWorkerHydrateRetry(key, npub, treeName, options, attempt + 1);
    });
  }, delay);
}

async function syncActiveTreeRootFromRecord(
  key: string,
  record: ReturnType<typeof treeRootRegistry.getByKey>,
  state: {
    decryptedKey: Hash | undefined;
  } | undefined
): Promise<void> {
  if (!record) return;
  if (key !== activeResolverKey) return;

  const currentRoute = get(routeStore);
  if (key !== getResolverKey(currentRoute.npub ?? undefined, currentRoute.treeName ?? undefined)) return;

  let effectiveKey = record.key ?? state?.decryptedKey;
  if (!effectiveKey && record.visibility === 'link-visible') {
    const visibilityInfo = getVisibilityInfoFromRegistry(key);
    const linkKeyFromUrl = currentRoute.params.get('k');
    if (shouldWaitForLinkVisibleMetadata({
      visibility: record.visibility,
      hasRouteLinkKey: !!linkKeyFromUrl,
      hasEncryptedKey: !!visibilityInfo?.encryptedKey,
      hasSessionDecryptedKey: !!state?.decryptedKey,
    })) {
      return;
    }
    const decryptedKey = await decryptEncryptionKey(visibilityInfo, undefined, linkKeyFromUrl);
    if (decryptedKey && state) {
      state.decryptedKey = decryptedKey;
    }
    effectiveKey = decryptedKey ?? effectiveKey;
  }

  if (record.visibility === 'link-visible' && !effectiveKey) return;

  treeRootStore.set(cid(record.hash, effectiveKey));
  logHtreeDebug('treeRoot:set', { source: 'registry-active', resolverKey: key });
}

/**
 * Update the subscription cache directly (called from feed subscriptions).
 * Keeps backward compatibility while updating the registry for UI consumers.
 */
export function updateSubscriptionCache(
  key: string,
  hash: Hash,
  encryptionKey?: Hash,
  options?: { updatedAt?: number; visibility?: TreeVisibility }
): void {
  const slashIndex = key.indexOf('/');
  if (slashIndex > 0 && slashIndex < key.length - 1) {
    const npub = key.slice(0, slashIndex);
    const treeName = key.slice(slashIndex + 1);
    const visibility = options?.visibility ?? treeRootRegistry.getVisibility(npub, treeName) ?? 'public';
    const updatedAt = options?.updatedAt ?? Math.floor(Date.now() / 1000);
    treeRootRegistry.setFromExternal(npub, treeName, hash, 'prefetch', {
      key: encryptionKey,
      visibility,
      updatedAt,
    });
    void syncNativeTreeRootCache(npub, treeName, { hash, key: encryptionKey }, visibility)
      .catch((error) => {
        console.warn('[treeRoot] Failed to sync native tree root cache:', error);
      });

  }

  let state = subscriptionState.get(key);
  if (!state) {
    // Create entry if it doesn't exist (for newly created trees)
    state = {
      decryptedKey: undefined,
      listeners: new Set(),
      unsubscribeResolver: null,
      unsubscribeWorker: null,
      workerHydrateRetryTimer: null,
    };
    subscriptionState.set(key, state);
  }
  state.decryptedKey = encryptionKey;
  const visibilityInfo = getVisibilityInfoFromRegistry(key);
  state.listeners.forEach(listener => listener(hash, encryptionKey, visibilityInfo, {
    updatedAt: options?.updatedAt ?? Math.floor(Date.now() / 1000),
  }));
}

// Subscribe to registry updates to notify listeners
treeRootRegistry.subscribeAll((key, record) => {
  if (!record) {
    workerRootCacheSync.delete(key);
    return;
  }
  const state = subscriptionState.get(key);
  if (state) {
    const visibilityInfo = getVisibilityInfoFromRegistry(key);
    state.listeners.forEach(listener => listener(record.hash, record.key, visibilityInfo, {
      updatedAt: record.updatedAt,
    }));
  }
  void syncActiveTreeRootFromRecord(key, record, state);
  void syncResolvedTreeRootToWorker(key, record);
});

/**
 * Subscribe to tree root updates for a specific npub/treeName
 * Returns an unsubscribe function
 */
export function subscribeToTreeRoot(
  npub: string,
  treeName: string,
  callback: (hash: Hash | null, encryptionKey?: Hash) => void
): () => void {
  const key = `${npub}/${treeName}`;
  return subscribeToResolver(key, callback);
}

/**
 * Start the resolver subscription after worker is ready
 * This is called asynchronously to ensure NDK transport plugin is registered
 */
async function startResolverSubscription(
  key: string,
  options?: { force?: boolean; skipWorkerHydrate?: boolean }
): Promise<void> {
  const workerReady = await Promise.race([
    waitForWorkerReady().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WORKER_READY_TIMEOUT_MS)),
  ]);
  if (!workerReady) {
    console.warn('[treeRoot] Worker not ready yet - subscribing anyway');
  }

  const state = subscriptionState.get(key);
  if (!state) return; // Entry was deleted before worker was ready

  // Don't create subscription if one already exists unless forced
  if (state.unsubscribeResolver || state.unsubscribeWorker) {
  if (!options?.force) return;
  state.unsubscribeResolver?.();
  state.unsubscribeResolver = null;
  state.unsubscribeWorker?.();
  state.unsubscribeWorker = null;
  clearWorkerHydrateRetry(key);
  }

  const slashIndex = key.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= key.length - 1) return;
  const npub = key.slice(0, slashIndex);
  const treeName = key.slice(slashIndex + 1);
  const currentRoute = get(routeStore);
  const hasRouteLinkKey = getResolverKey(currentRoute.npub ?? undefined, currentRoute.treeName ?? undefined) === key
    && !!currentRoute.params.get('k');

  const subscribed = await ensureWorkerTreeRootSubscription(npub);
  const hydrated = options?.skipWorkerHydrate
    ? false
    : await hydrateTreeRootFromWorker(npub, treeName);
  const subscriptionPlan = getTreeRootSubscriptionPlan({
    workerSubscribed: subscribed,
    workerHydrated: hydrated,
    hasRouteLinkKey,
  });

  if (subscriptionPlan.attachWorkerSubscription) {
    state.unsubscribeWorker = () => {
      void unsubscribeWorkerTreeRootSubscription(npub);
    };
    if (!hydrated) {
      scheduleWorkerHydrateRetry(key, npub, treeName, options);
    }
  }

  if (!subscriptionPlan.useResolverSubscription) {
    return;
  }

  const resolver = getRefResolver();
  state.unsubscribeResolver = resolver.subscribe(key, (resolvedCid, visibilityInfo, metadata) => {
    const entry = subscriptionState.get(key);
    if (entry) {
      // Update registry with resolver data (only if newer)
      if (resolvedCid?.hash) {
        const updatedAt = getResolverUpdatedAt(metadata);

        treeRootRegistry.setFromResolver(npub, treeName, resolvedCid.hash, updatedAt, {
          key: resolvedCid.key,
          visibility: visibilityInfo?.visibility ?? 'public',
          labels: treeRootRegistry.getLabels(npub, treeName),
          encryptedKey: visibilityInfo?.encryptedKey,
          keyId: visibilityInfo?.keyId,
          selfEncryptedKey: visibilityInfo?.selfEncryptedKey,
          selfEncryptedLinkKey: visibilityInfo?.selfEncryptedLinkKey,
        });
      }

      entry.listeners.forEach(listener => listener(
        resolvedCid?.hash ?? null,
        resolvedCid?.key,
        visibilityInfo,
        metadata,
      ));
    }
  });

  void waitForWorkerReady().then(async () => {
    const active = subscriptionState.get(key);
    if (!active || active.unsubscribeWorker) return;
    const subscribed = await ensureWorkerTreeRootSubscription(npub);
    const hydrated = options?.skipWorkerHydrate
      ? false
      : await hydrateTreeRootFromWorker(npub, treeName);
    const retryPlan = getTreeRootSubscriptionPlan({
      workerSubscribed: subscribed,
      workerHydrated: hydrated,
      hasRouteLinkKey,
    });
    if (retryPlan.attachWorkerSubscription) {
      active.unsubscribeWorker = () => {
        void unsubscribeWorkerTreeRootSubscription(npub);
      };
      if (!hydrated) {
        scheduleWorkerHydrateRetry(key, npub, treeName, options);
      }
    }
  });
}

function getResolverUpdatedAt(metadata?: RefResolverSubscriptionMetadata): number {
  return metadata?.updatedAt ?? Math.floor(Date.now() / 1000);
}

function subscribeToResolver(
  key: string,
  callback: (
    hash: Hash | null,
    encryptionKey?: Hash,
    visibilityInfo?: SubscribeVisibilityInfo,
    metadata?: RefResolverSubscriptionMetadata
  ) => void
): () => void {
  let state = subscriptionState.get(key);
  const hadState = !!state;

  if (!state) {
    state = {
      decryptedKey: undefined,
      listeners: new Set(),
      unsubscribeResolver: null,
      unsubscribeWorker: null,
      workerHydrateRetryTimer: null,
    };
    subscriptionState.set(key, state);
  }

  if (shouldStartTreeRootSubscription({
    hasState: hadState,
    hasResolverSubscription: !!state.unsubscribeResolver,
    hasWorkerSubscription: !!state.unsubscribeWorker,
  })) {
    // Start or restart the subscription asynchronously after worker is ready.
    // Cached state entries are retained even when listeners drop to zero, so we
    // must restart the underlying subscriptions when a new consumer arrives.
    startResolverSubscription(key);
  }

  state.listeners.add(callback);

  // Emit current snapshot from registry if available
  const record = treeRootRegistry.getByKey(key);
  if (record) {
    const visibilityInfo = getVisibilityInfoFromRegistry(key);
    const currentRoute = get(routeStore);
    const hasRouteLinkKey = getResolverKey(currentRoute.npub ?? undefined, currentRoute.treeName ?? undefined) === key
      && !!currentRoute.params.get('k');
    const state = subscriptionState.get(key);

    if (!shouldWaitForLinkVisibleMetadata({
      visibility: record.visibility,
      hasRouteLinkKey,
      hasEncryptedKey: !!visibilityInfo?.encryptedKey,
      hasSessionDecryptedKey: !!state?.decryptedKey,
    })) {
      queueMicrotask(() => callback(record.hash, record.key, visibilityInfo, { updatedAt: record.updatedAt }));
    }
  }

  return () => {
    const cached = subscriptionState.get(key);
    if (cached) {
      cached.listeners.delete(callback);
      // Note: We don't delete the cache entry when the last listener unsubscribes
      // because the data is still valid and may be needed by other components
      // (e.g., DocCard uses getTreeRootSync after the editor unmounts)
      if (cached.listeners.size === 0) {
        cached.unsubscribeResolver?.();
        cached.unsubscribeResolver = null;
        cached.unsubscribeWorker?.();
        cached.unsubscribeWorker = null;
        clearWorkerHydrateRetry(key);
        // Keep the cached data, just stop the subscription
        // subscriptionState.delete(key);
      }
    }
  };
}

function refreshResolverSubscription(
  key: string,
  options?: { skipWorkerHydrate?: boolean }
): void {
  if (!subscriptionState.has(key)) return;
  startResolverSubscription(key, { force: true, skipWorkerHydrate: options?.skipWorkerHydrate });
}

/**
 * Decrypt the encryption key for a tree based on visibility and available keys
 */
async function decryptEncryptionKey(
  visibilityInfo: SubscribeVisibilityInfo | undefined,
  encryptionKey: Hash | undefined,
  linkKey: string | null
): Promise<Hash | undefined> {
  if (encryptionKey) {
    return encryptionKey;
  }

  if (!visibilityInfo) {
    // Fallback: if linkKey is present but no visibility info, use linkKey directly
    if (linkKey && linkKey.length === 64) {
      try {
        return fromHex(linkKey);
      } catch (e) {
        console.debug('Could not use linkKey directly:', e);
      }
    }
    return undefined;
  }

  // Link-visible tree with linkKey from URL
  if (visibilityInfo.visibility === 'link-visible' && linkKey) {
    logHtreeDebug('treeRoot:decrypt-link', {
      hasEncryptedKey: !!visibilityInfo.encryptedKey,
      encryptedKeyPrefix: visibilityInfo.encryptedKey?.slice(0, 16) ?? null,
      linkKeyPrefix: linkKey.slice(0, 16),
    });

    if (visibilityInfo.encryptedKey) {
      try {
        const decryptedHex = await visibilityHex.decryptKeyFromLink(visibilityInfo.encryptedKey, linkKey);
        logHtreeDebug('treeRoot:decrypt-link-result', {
          success: !!decryptedHex,
          resultPrefix: decryptedHex?.slice(0, 16) ?? null,
        });
        if (decryptedHex) {
          return fromHex(decryptedHex);
        }
        console.warn('[decryptEncryptionKey] Key mismatch - linkKey does not decrypt encryptedKey');
      } catch (e) {
        console.error('[decryptEncryptionKey] Decryption failed:', e);
      }
    } else {
      console.warn('[decryptEncryptionKey] Link-visible tree missing encryptedKey metadata; waiting for resolver update');
    }
    return undefined;
  }

  // Link-visible tree - owner access via selfEncryptedLinkKey
  // Decrypt linkKey, then derive contentKey from encryptedKey
  if (visibilityInfo.visibility === 'link-visible' && visibilityInfo.encryptedKey && visibilityInfo.selfEncryptedLinkKey) {
    try {
      const state = getNostrState();
      if (state.pubkey) {
        const decryptedLinkKey = await decrypt(state.pubkey, visibilityInfo.selfEncryptedLinkKey);
        if (decryptedLinkKey && decryptedLinkKey.length === 64) {
          const decryptedHex = await visibilityHex.decryptKeyFromLink(visibilityInfo.encryptedKey, decryptedLinkKey);
          if (decryptedHex) {
            return fromHex(decryptedHex);
          }
        }
      }
    } catch (e) {
      console.debug('Could not decrypt via selfEncryptedLinkKey (not owner?):', e);
    }
  }

  // Private tree - try selfEncryptedKey (owner access)
  if (visibilityInfo.selfEncryptedKey) {
    try {
      const state = getNostrState();
      if (state.pubkey) {
        // Use centralized decrypt (works with both nsec and extension login)
        const decrypted = await decrypt(state.pubkey, visibilityInfo.selfEncryptedKey);
        return fromHex(decrypted);
      }
    } catch (e) {
      console.debug('Could not decrypt selfEncryptedKey (not owner?):', e);
    }
  }

  // Fallback: if linkKey is present but we have no visibility metadata at all,
  // try using it directly for legacy content.
  if (linkKey && linkKey.length === 64) {
    try {
      return fromHex(linkKey);
    } catch (e) {
      console.debug('Could not use linkKey directly:', e);
    }
  }

  return undefined;
}

// Store for tree root
export const treeRootStore = writable<CID | null>(null);

/**
 * Recover linkKey for URL when owner navigates to link-visible without k= param
 * This allows easy sharing by copying URL from address bar
 */
async function recoverLinkKeyForUrl(resolverKey: string): Promise<void> {
  const npubStr = resolverKey.split('/')[0];
  const treeName = resolverKey.split('/').slice(1).join('/');
  const resolver = getRefResolver();

  // Use list to get fresh visibility data
  const entries = await new Promise<ResolverListVisibilityEntry[] | null>((resolve) => {
    let resolved = false;

    const unsub = resolver.list?.(npubStr, (list) => {
      if (resolved) return;
      resolved = true;
      // Defer unsubscribe to avoid calling it during callback
      setTimeout(() => unsub?.(), 0);
      // list entries have 'key' field like 'npub/treeName', we need to match by treeName
      const entry = list.find(e => {
        const keyParts = e.key?.split('/');
        const entryTreeName = keyParts?.slice(1).join('/');
        return entryTreeName === treeName;
      });
      resolve(entry ? [entry as ResolverListVisibilityEntry] : null);
    });

    // Timeout after 2 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub?.();
        resolve(null);
      }
    }, 2000);
  });

  if (!entries?.[0]) return;

  const { visibility, selfEncryptedLinkKey } = entries[0];
  if (visibility !== 'link-visible' || !selfEncryptedLinkKey) return;

  try {
    const state = getNostrState();
    const { nip19: nip19Mod } = await import('nostr-tools');
    const decoded = nip19Mod.decode(npubStr);
    const treePubkey = decoded.type === 'npub' ? decoded.data as string : null;

    if (state.pubkey && treePubkey && state.pubkey === treePubkey) {
      const decryptedLinkKey = await decrypt(state.pubkey, selfEncryptedLinkKey);
      if (decryptedLinkKey && decryptedLinkKey.length === 64) {
        // Update URL with k= param (use replaceState to avoid history pollution)
        const currentHash = window.location.hash;
        if (!currentHash.includes('k=')) {
          const separator = currentHash.includes('?') ? '&' : '?';
          window.history.replaceState(null, '', currentHash + separator + 'k=' + decryptedLinkKey);
        }
      }
    }
  } catch (e) {
    console.debug('[treeRoot] Could not recover linkKey for URL:', e);
  }
}

// Active subscription cleanup
let activeUnsubscribe: (() => void) | null = null;
let activeResolverKey: string | null = null;
let resolverRetryTimer: ReturnType<typeof setTimeout> | null = null;
let resolverRetryAttempts = 0;
const RESOLVER_RETRY_DELAY_MS = 2000;
const RESOLVER_RETRY_MAX_ATTEMPTS = 5;

function resetResolverRetry(): void {
  if (resolverRetryTimer) {
    clearTimeout(resolverRetryTimer);
    resolverRetryTimer = null;
  }
  resolverRetryAttempts = 0;
}

function scheduleResolverRetry(resolverKey: string): void {
  if (resolverRetryTimer) return;
  if (getNostrState().connectedRelays === 0) return;

  resolverRetryTimer = setTimeout(() => {
    resolverRetryTimer = null;
    if (resolverKey !== activeResolverKey) return;

    // Check registry instead of subscriptionCache
    const record = treeRootRegistry.getByKey(resolverKey);
    if (record?.hash) {
      resetResolverRetry();
      return;
    }

    resolverRetryAttempts += 1;
    refreshResolverSubscription(resolverKey);

    if (resolverRetryAttempts < RESOLVER_RETRY_MAX_ATTEMPTS) {
      scheduleResolverRetry(resolverKey);
    }
  }, RESOLVER_RETRY_DELAY_MS);
}

/**
 * Create a tree root store that reacts to route changes
 */
export function createTreeRootStore(): Readable<CID | null> {
  // Subscribe to route changes
  routeStore.subscribe(async (route) => {
    logHtreeDebug('treeRoot:route', {
      npub: route.npub,
      treeName: route.treeName,
      isPermalink: route.isPermalink,
      path: route.path?.join('/') ?? '',
      hasCid: !!route.cid,
    });
    // For permalinks, use CID from route (already Uint8Array from nhashDecode)
    if (route.isPermalink && route.cid) {
      if (isSnapshotPermalinkSync(route)) {
        treeRootStore.set(getPermalinkSnapshotSync().rootCid);
        logHtreeDebug('treeRoot:set', { source: 'snapshot-permalink' });
      } else {
        treeRootStore.set(route.cid);
        logHtreeDebug('treeRoot:set', { source: 'permalink' });
      }

      // Cleanup any active subscription
      if (activeUnsubscribe) {
        activeUnsubscribe();
        activeUnsubscribe = null;
        activeResolverKey = null;
      }
      resetResolverRetry();
      return;
    }

    // For tree routes, subscribe to resolver
    const resolverKey = getResolverKey(route.npub ?? undefined, route.treeName ?? undefined);
    if (!resolverKey) {
      treeRootStore.set(null);
      logHtreeDebug('treeRoot:clear', { reason: 'no-resolver-key' });
      if (activeUnsubscribe) {
        activeUnsubscribe();
        activeUnsubscribe = null;
        activeResolverKey = null;
      }
      resetResolverRetry();
      return;
    }

    // Same key, no need to resubscribe
    // But still check if we need to recover k= param for URL, and restore the
    // store from the registry snapshot if a same-tree navigation cleared it.
    if (resolverKey === activeResolverKey) {
      const cachedRoot = getTreeRootSync(route.npub, route.treeName);
      const cachedRecord = treeRootRegistry.getByKey(resolverKey);
      const cachedState = subscriptionState.get(resolverKey);
      const shouldUseCachedRoot = !!cachedRoot && !shouldWaitForLinkVisibleMetadata({
        visibility: cachedRecord?.visibility,
        hasRouteLinkKey: !!route.params.get('k'),
        hasEncryptedKey: !!cachedRecord?.encryptedKey,
        hasSessionDecryptedKey: !!cachedState?.decryptedKey,
      });
      if (shouldUseCachedRoot && !get(treeRootStore)) {
        treeRootStore.set(cachedRoot);
        logHtreeDebug('treeRoot:set', { source: 'registry-reuse', resolverKey });
      }
      const currentRoute = get(routeStore);
      const linkKeyFromUrl = currentRoute.params.get('k');
      if (!linkKeyFromUrl) {
        recoverLinkKeyForUrl(resolverKey);
      }
      logHtreeDebug('treeRoot:reuse', { resolverKey });
      return;
    }

    // Cleanup previous subscription
    if (activeUnsubscribe) {
      activeUnsubscribe();
    }

    // Reset while waiting for new data
    treeRootStore.set(null);
    activeResolverKey = resolverKey;
    resetResolverRetry();
    logHtreeDebug('treeRoot:subscribe', { resolverKey });
    logHtreeDebug('treeRoot:subscribe', { resolverKey });

    // Use cached registry value immediately if available (offline-first / test stability)
    const cachedRoot = getTreeRootSync(route.npub, route.treeName);
    const cachedRecord = treeRootRegistry.getByKey(resolverKey);
    const cachedState = subscriptionState.get(resolverKey);
    const shouldUseCachedRoot = !!cachedRoot && !shouldWaitForLinkVisibleMetadata({
      visibility: cachedRecord?.visibility,
      hasRouteLinkKey: !!route.params.get('k'),
      hasEncryptedKey: !!cachedRecord?.encryptedKey,
      hasSessionDecryptedKey: !!cachedState?.decryptedKey,
    });
    if (shouldUseCachedRoot) {
      treeRootStore.set(cachedRoot);
      logHtreeDebug('treeRoot:set', { source: 'registry' });
    }

    // Subscribe to resolver
    activeUnsubscribe = subscribeToResolver(resolverKey, async (hash, encryptionKey, visibilityInfo, metadata) => {
      if (!hash) {
        const fallbackRoot = getTreeRootSync(route.npub, route.treeName);
        if (fallbackRoot) {
          treeRootStore.set(fallbackRoot);
          logHtreeDebug('treeRoot:set', { source: 'registry-fallback', resolverKey });
        } else {
          treeRootStore.set(null);
          logHtreeDebug('treeRoot:clear', { reason: 'no-hash', resolverKey });
        }
        return;
      }

      const updatedAt = getResolverUpdatedAt(metadata);

      logHtreeDebug('treeRoot:resolver', {
        resolverKey,
        hasHash: !!hash,
        hasEncryptionKey: !!encryptionKey,
        visibility: visibilityInfo?.visibility ?? null,
        hasEncryptedKey: !!visibilityInfo?.encryptedKey,
        updatedAt,
      });

      // Get current route params (not the closure-captured route from subscription time)
      const currentRoute = get(routeStore);
      const linkKeyFromUrl = currentRoute.params.get('k');
      const decryptedKey = await decryptEncryptionKey(visibilityInfo, encryptionKey, linkKeyFromUrl);
      const cachedState = subscriptionState.get(resolverKey);
      const effectiveKey = decryptedKey ?? cachedState?.decryptedKey;

      // Cache the decrypted key
      if (effectiveKey && cachedState) {
        cachedState.decryptedKey = effectiveKey;
      }

      resetResolverRetry();

      // If owner viewing link-visible without k= param, recover linkKey and update URL
      // This allows owner to share the URL easily (copy from address bar includes k=)
      if (!linkKeyFromUrl) {
        // Try to get visibility info - check visibilityInfo first, then fall back to resolver list
        let selfEncryptedLinkKey = visibilityInfo?.selfEncryptedLinkKey;
        let visibility = visibilityInfo?.visibility;
        let listEntries: ResolverListVisibilityEntry[] | null = null;

        // If we don't have selfEncryptedLinkKey from the callback, try to get it from resolver list
        if (!selfEncryptedLinkKey) {
          const npubStr = resolverKey.split('/')[0];
          const treeName = resolverKey.split('/').slice(1).join('/');
          const resolver = getRefResolver();

          // Use list to get fresh visibility data
          listEntries = await new Promise<ResolverListVisibilityEntry[] | null>((resolve) => {
            let resolved = false;

            const unsub = resolver.list?.(npubStr, (list) => {
              if (resolved) return;
              resolved = true;
              // Defer unsubscribe to avoid calling it during callback
              setTimeout(() => unsub?.(), 0);
              // list entries have 'key' field like 'npub/treeName', we need to match by treeName
              const entry = list.find(e => {
                const keyParts = e.key?.split('/');
                const entryTreeName = keyParts?.slice(1).join('/');
                return entryTreeName === treeName;
              });
              resolve(entry ? [entry as ResolverListVisibilityEntry] : null);
            });

            // Timeout after 2 seconds
            setTimeout(() => {
              if (!resolved) {
                resolved = true;
                unsub?.();
                resolve(null);
              }
            }, 2000);
          });

          if (listEntries && listEntries[0]) {
            selfEncryptedLinkKey = listEntries[0].selfEncryptedLinkKey;
            visibility = listEntries[0].visibility as typeof visibility;
          }
        }

        if (visibility === 'link-visible') {
          const state = getNostrState();
          const npubStr = resolverKey.split('/')[0];
          const { nip19: nip19Mod } = await import('nostr-tools');
          const decoded = nip19Mod.decode(npubStr);
          const treePubkey = decoded.type === 'npub' ? decoded.data as string : null;
          const isOwner = state.pubkey && treePubkey && state.pubkey === treePubkey;

          if (isOwner) {
            if (selfEncryptedLinkKey) {
              // Decrypt linkKey and update URL
              try {
                const linkKeyHex = await decrypt(state.pubkey!, selfEncryptedLinkKey);
                if (linkKeyHex && linkKeyHex.length === 64) {
                  const currentHash = window.location.hash;
                  // Only add k= if not already present
                  if (!currentHash.includes('k=')) {
                    const separator = currentHash.includes('?') ? '&' : '?';
                    window.history.replaceState(null, '', currentHash + separator + 'k=' + linkKeyHex);
                  }
                }
              } catch (e) {
                console.error('[treeRoot] Could not decrypt linkKey:', e);
              }
            } else {
              // Migration: old event without selfEncryptedLinkKey
              // Try to derive linkKey from contentKey and encryptedKey (XOR)
              const treeName = resolverKey.split('/').slice(1).join('/');
              const { toHex, visibilityHex } = await import('@hashtree/core');

              // Get encryptedKey from visibilityInfo or list
              let encryptedKeyHex = visibilityInfo?.encryptedKey;
              if (!encryptedKeyHex && listEntries?.[0]) {
                encryptedKeyHex = listEntries[0].encryptedKey;
              }

              // Get selfEncryptedKey for decrypting contentKey
              let selfEncryptedKey = visibilityInfo?.selfEncryptedKey;
              if (!selfEncryptedKey && listEntries?.[0]) {
                selfEncryptedKey = listEntries[0].selfEncryptedKey;
              }

              logHtreeDebug('treeRoot:migration-check', {
                hasSelfEncryptedKey: !!selfEncryptedKey,
                hasEncryptedKey: !!encryptedKeyHex,
                visibility: visibility ?? null,
              });

              if (encryptedKeyHex && selfEncryptedKey) {
                try {
                  // Decrypt contentKey from selfEncryptedKey
                  const contentKeyHex = await decrypt(state.pubkey!, selfEncryptedKey);
                  logHtreeDebug('treeRoot:migration-decrypted', {
                    contentKeyHex: contentKeyHex ? `${contentKeyHex.slice(0, 16)}...` : null,
                    length: contentKeyHex?.length ?? null,
                  });
                  if (contentKeyHex && contentKeyHex.length === 64) {
                    // Derive linkKey = XOR(encryptedKey, contentKey)
                    const linkKeyHex = visibilityHex.encryptKeyForLink(contentKeyHex, encryptedKeyHex);

                    logHtreeDebug('treeRoot:migration-linkkey', {
                      linkKeyHex: `${linkKeyHex.slice(0, 16)}...`,
                    });

                    const currentHash = window.location.hash;
                    if (!currentHash.includes('k=')) {
                      const separator = currentHash.includes('?') ? '&' : '?';
                      window.history.replaceState(null, '', currentHash + separator + 'k=' + linkKeyHex);
                    }

                    // Optionally republish with selfEncryptedLinkKey for future URL recovery
                    try {
                      const resolver = getRefResolver();
                      const { fromHex } = await import('@hashtree/core');
                      if (!resolver.publish) {
                        throw new Error('Resolver does not support publish');
                      }
                      await resolver.publish(treeName, cid(hash, fromHex(contentKeyHex)), {
                        visibility: 'link-visible',
                        linkKey: fromHex(linkKeyHex),
                      });
                    } catch (e) {
                      console.debug('[treeRoot] Migration republish failed:', e);
                    }
                  }
                } catch (e) {
                  console.debug('[treeRoot] Could not derive linkKey from selfEncryptedKey:', e);
                }
              } else if (encryptedKeyHex) {
                // Fallback: try to get contentKey from local cache or decryptedKey
                const npubStr = resolverKey.split('/')[0];
                const { getLocalRootKey } = await import('../treeRootCache');
                const cachedKey = getLocalRootKey(npubStr, treeName);
                const contentKey = decryptedKey || cachedKey;

                logHtreeDebug('treeRoot:migration-fallback', {
                  hasDecryptedKey: !!decryptedKey,
                  hasCachedKey: !!cachedKey,
                  hasContentKey: !!contentKey,
                  encryptedKeyHex: encryptedKeyHex ? `${encryptedKeyHex.slice(0, 16)}...` : null,
                });

                if (contentKey) {
                  try {
                    const contentKeyHex = toHex(contentKey);
                    const linkKeyHex = visibilityHex.encryptKeyForLink(contentKeyHex, encryptedKeyHex);

                    logHtreeDebug('treeRoot:migration-computed-linkkey', {
                      contentKeyHex: `${contentKeyHex.slice(0, 16)}...`,
                      linkKeyHex: `${linkKeyHex.slice(0, 16)}...`,
                    });

                    const currentHash = window.location.hash;
                    if (!currentHash.includes('k=')) {
                      const separator = currentHash.includes('?') ? '&' : '?';
                      window.history.replaceState(null, '', currentHash + separator + 'k=' + linkKeyHex);
                    }

                    // Republish with new linkKey and selfEncryptedLinkKey (fire and forget)
                    const resolver = getRefResolver();
                    if (!resolver.publish) {
                      throw new Error('Resolver does not support publish');
                    }
                    resolver.publish(treeName, cid(hash, contentKey), {
                      visibility: 'link-visible',
                    }).catch(e => console.debug('[treeRoot] Migration republish failed:', e));
                  } catch (e) {
                    console.debug('[treeRoot] Could not derive linkKey from contentKey:', e);
                  }
                } else {
                  logHtreeDebug('treeRoot:migration-no-content-key');
                }
              }
            }
          }
        }
      }

      // For link-visible content, don't set store until we have the decryption key
      // This prevents the video player from trying to load before decryption is possible
      const visibility = visibilityInfo?.visibility;

      // If we have k= param but no visibilityInfo yet, wait for resolver to fetch the event
      // (we need encryptedKey from event to XOR with linkKey)
      // BUT: if we already have encryptionKey from local cache (owner just created tree),
      // we can proceed without waiting for visibilityInfo
      if (linkKeyFromUrl && !visibilityInfo?.encryptedKey && !encryptionKey && !effectiveKey) {
        logHtreeDebug('treeRoot:wait-encrypted-key', { resolverKey });
        return;
      }

      if (visibility === 'link-visible' && !effectiveKey) {
        logHtreeDebug('treeRoot:wait-decrypted-key', { resolverKey });
        // Don't set the store - wait for next callback with key
        return;
      }

      const slashIndex = resolverKey.indexOf('/');
      const resolverNpub = slashIndex > 0 ? resolverKey.slice(0, slashIndex) : null;
      const resolverTreeName = slashIndex > 0 && slashIndex < resolverKey.length - 1
        ? resolverKey.slice(slashIndex + 1)
        : null;

      if (effectiveKey && resolverNpub && resolverTreeName && (encryptionKey || visibilityInfo?.encryptedKey)) {
        treeRootRegistry.setFromResolver(resolverNpub, resolverTreeName, hash, updatedAt, {
          key: effectiveKey,
          visibility: visibilityInfo?.visibility ?? treeRootRegistry.getVisibility(resolverNpub, resolverTreeName) ?? 'public',
          labels: treeRootRegistry.getLabels(resolverNpub, resolverTreeName),
          encryptedKey: visibilityInfo?.encryptedKey,
          keyId: visibilityInfo?.keyId,
          selfEncryptedKey: visibilityInfo?.selfEncryptedKey,
          selfEncryptedLinkKey: visibilityInfo?.selfEncryptedLinkKey,
        });
      }

      // Set the store FIRST so UI updates immediately
      treeRootStore.set(cid(hash, effectiveKey));
      logHtreeDebug('treeRoot:set', {
        resolverKey,
        visibility: visibility ?? null,
        hasDecryptedKey: !!effectiveKey,
      });

      // Then merge key to registry and worker in the background (don't block UI)
      if (resolverNpub && resolverTreeName) {
        if (effectiveKey) {
          treeRootRegistry.mergeKey(resolverNpub, resolverTreeName, hash, effectiveKey);
          const signature = `${toHex(hash)}:${toHex(effectiveKey)}`;
          if (workerKeyMergeCache.get(resolverKey) !== signature) {
            // Fire and forget - don't await, let it run in background
            void mergeTreeRootKeyToWorker(resolverNpub, resolverTreeName, hash, effectiveKey).then((merged) => {
              if (merged) {
                workerKeyMergeCache.set(resolverKey, signature);
              }
            });
          }
        }
      }
    });

    scheduleResolverRetry(resolverKey);
  });

  let lastConnectedRelays = getNostrState().connectedRelays;
  nostrStore.subscribe((state: NostrState) => {
    const connected = state.connectedRelays;
    if (connected > 0 && lastConnectedRelays === 0 && activeResolverKey) {
      const record = treeRootRegistry.getByKey(activeResolverKey);
      if (!record?.hash) {
        refreshResolverSubscription(activeResolverKey);
        scheduleResolverRetry(activeResolverKey);
      }
    }
    lastConnectedRelays = connected;
  });

  return treeRootStore;
}

/**
 * Get the current root CID synchronously
 */
export function getTreeRootSync(npub: string | null | undefined, treeName: string | null | undefined): CID | null {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return null;

  // Check registry first
  const record = treeRootRegistry.getByKey(key);
  if (record?.hash) {
    if (record.key) {
      return cid(record.hash, record.key);
    }
    const state = subscriptionState.get(key);
    if (state?.decryptedKey) {
      return cid(record.hash, state.decryptedKey);
    }
    return cid(record.hash);
  }

  // Fallback to subscription state for decrypted key
  const state = subscriptionState.get(key);
  if (state?.decryptedKey && record?.hash) {
    return cid(record.hash, state.decryptedKey);
  }

  return null;
}

async function resolveTreeRootWithLinkKey(
  key: string,
  linkKey: string | null = null
): Promise<CID | null> {
  const record = treeRootRegistry.getByKey(key);
  if (!record?.hash) return null;

  const state = subscriptionState.get(key);
  const visibilityInfo = getVisibilityInfoFromRegistry(key);
  let effectiveKey = record.key ?? state?.decryptedKey;

  if (!effectiveKey && (linkKey || visibilityInfo?.selfEncryptedKey || visibilityInfo?.selfEncryptedLinkKey)) {
    const decryptedKey = await decryptEncryptionKey(visibilityInfo, undefined, linkKey);
    if (decryptedKey) {
      const slashIndex = key.indexOf('/');
      if (slashIndex > 0 && slashIndex < key.length - 1) {
        const npub = key.slice(0, slashIndex);
        const treeName = key.slice(slashIndex + 1);
        treeRootRegistry.mergeKey(npub, treeName, record.hash, decryptedKey);
      }
      if (state) {
        state.decryptedKey = decryptedKey;
      }
      effectiveKey = decryptedKey;
    }
  }

  if ((visibilityInfo?.visibility ?? record.visibility) === 'link-visible' && !effectiveKey) {
    return null;
  }

  return cid(record.hash, effectiveKey);
}

export async function getTreeRoot(
  npub: string | null | undefined,
  treeName: string | null | undefined,
  linkKey: string | null = null
): Promise<CID | null> {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return null;

  if (!linkKey) {
    return getTreeRootSync(npub, treeName);
  }

  return resolveTreeRootWithLinkKey(key, linkKey);
}

/**
 * Wait for tree root to be resolved (async version of getTreeRootSync)
 * Subscribes to the resolver and waits for the first non-null result or timeout
 */
export function waitForTreeRoot(
  npub: string,
  treeName: string,
  timeoutMs: number = 10000,
  linkKey: string | null = null
): Promise<CID | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let unsub: (() => void) | null = null;
    const finish = (value: CID | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      unsub?.();
      resolve(value);
    };

    const maybeResolve = async (hash: Hash | null, encryptionKey?: Hash) => {
      if (!hash || resolved) return;
      if (encryptionKey) {
        finish(cid(hash, encryptionKey));
        return;
      }

      const hydrated = await getTreeRoot(npub, treeName, linkKey);
      if (hydrated) {
        finish(hydrated);
        return;
      }

      if (treeRootRegistry.getVisibility(npub, treeName) === 'link-visible') {
        return;
      }

      finish(cid(hash));
    };

    const timeout = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    void getTreeRoot(npub, treeName, linkKey).then((root) => {
      if (root) {
        finish(root);
      }
    });

    unsub = subscribeToTreeRoot(npub, treeName, (hash, encryptionKey) => {
      void maybeResolve(hash, encryptionKey);
    });
  });
}

/**
 * Invalidate and refresh the cached root CID
 */
export async function invalidateTreeRoot(npub: string | null | undefined, treeName: string | null | undefined): Promise<void> {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return;
  if (npub && treeName) {
    treeRootRegistry.delete(npub, treeName);
  }
  workerKeyMergeCache.delete(key);
  workerRootCacheSync.delete(key);

  if (activeResolverKey === key) {
    treeRootStore.set(null);
  }

  refreshResolverSubscription(key, { skipWorkerHydrate: true });
  scheduleResolverRetry(key);
}

// Synchronously parse initial permalink (no resolver needed for nhash URLs)
// This must run BEFORE currentDirHash.ts subscribes to avoid race condition
function initializePermalink(): void {
  if (typeof window === 'undefined') return;

  const route = parseRouteFromHash(window.location.hash);
  if (route.isPermalink && route.cid && !isSnapshotPermalinkSync(route)) {
    // route.cid is already a CID with Uint8Array fields from nhashDecode
    treeRootStore.set(route.cid);
  }
}

// Initialize permalink synchronously (before currentDirHash subscribes)
initializePermalink();

permalinkSnapshotStore.subscribe((state) => {
  const route = get(routeStore);
  if (!isSnapshotPermalinkSync(route)) {
    return;
  }
  treeRootStore.set(state.rootCid);
});

// Initialize the store once - guard against HMR re-initialization
// Store the flag on a global to persist across HMR module reloads
const HMR_KEY = '__treeRootStoreInitialized';
const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;

// Use queueMicrotask to defer until after module initialization completes
// This avoids circular dependency issues with nostr.ts -> store.ts
queueMicrotask(() => {
  if ((globalObj as Record<string, unknown>)[HMR_KEY]) return;
  (globalObj as Record<string, unknown>)[HMR_KEY] = true;
  createTreeRootStore();
});
