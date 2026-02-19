import { fromHex, toHex, type Store } from '@hashtree/core';
import {
  WebRTCController,
  WebRTCProxy,
  SIGNALING_KIND,
  createSignalingFilters,
  decodeSignalingEvent,
  sendSignalingMessage,
  type GiftSeal,
  type SignalingInnerEvent,
  type SignalingTemplate,
} from '@hashtree/worker/p2p';
import type { SignalingMessage } from '@hashtree/nostr';
import { SimplePool, type Event, nip44 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { writable } from 'svelte/store';
import {
  blossomBandwidthStore,
  getBlob,
  getBlobForPeer,
  putBlob,
  setP2PFetchHandler,
} from './workerClient';
import { settingsStore } from './settings';

const STATS_INTERVAL_MS = 1000;

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://temp.iris.to',
];

export type P2PRelayStatus = 'connected' | 'connecting' | 'disconnected';

export interface P2PRelayState {
  url: string;
  status: P2PRelayStatus;
}

export interface P2PPeerState {
  peerId: string;
  pubkey: string;
  connected: boolean;
  pool: 'follows' | 'other';
  bytesSent: number;
  bytesReceived: number;
  requestsSent: number;
  requestsReceived: number;
  responsesSent: number;
  responsesReceived: number;
  forwardedRequests: number;
  forwardedResolved: number;
  forwardedSuppressed: number;
}

export interface BlossomBandwidthServerState {
  url: string;
  bytesSent: number;
  bytesReceived: number;
}

export interface BlossomBandwidthState {
  totalBytesSent: number;
  totalBytesReceived: number;
  updatedAt: number;
  servers: BlossomBandwidthServerState[];
}

export interface P2PState {
  started: boolean;
  peerCount: number;
  relayCount: number;
  connectedRelayCount: number;
  pubkey: string | null;
  peers: P2PPeerState[];
  relays: P2PRelayState[];
  blossomBandwidth: BlossomBandwidthState;
}

const DEFAULT_BLOSSOM_BANDWIDTH: BlossomBandwidthState = {
  totalBytesSent: 0,
  totalBytesReceived: 0,
  updatedAt: 0,
  servers: [],
};

const DEFAULT_STATE: P2PState = {
  started: false,
  peerCount: 0,
  relayCount: 0,
  connectedRelayCount: 0,
  pubkey: null,
  peers: [],
  relays: [],
  blossomBandwidth: DEFAULT_BLOSSOM_BANDWIDTH,
};

export const p2pStore = writable<P2PState>(DEFAULT_STATE);

let controller: WebRTCController | null = null;
let proxy: WebRTCProxy | null = null;
let pool: SimplePool | null = null;
let secretKey: Uint8Array | null = null;
let publicKey: string | null = null;
let currentRelays: string[] = DEFAULT_RELAYS;
let subscriptions: Array<{ close: () => void }> = [];
let statsTimer: ReturnType<typeof setInterval> | null = null;
let settingsUnsubscribe: (() => void) | null = null;
let blossomBandwidthUnsubscribe: (() => void) | null = null;
let initPromise: Promise<void> | null = null;
let localStoreReadDepth = 0;
let currentBlossomBandwidth: BlossomBandwidthState = DEFAULT_BLOSSOM_BANDWIDTH;

declare global {
  interface Window {
    __hashtreeCcP2P?: {
      started: boolean;
      peerCount: number;
      relayCount: number;
      connectedRelayCount: number;
      pubkey: string | null;
      peers: P2PPeerState[];
      relays: P2PRelayState[];
      blossomBandwidth: BlossomBandwidthState;
    };
  }
}

function normalizeRelay(relay: string): string {
  return relay.trim().replace(/\/+$/, '');
}

function normalizeRelays(relays: string[] | undefined): string[] {
  const source = relays && relays.length > 0 ? relays : DEFAULT_RELAYS;
  const unique = new Set<string>();
  for (const relay of source) {
    const normalized = normalizeRelay(relay);
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

function getRelayStates(): P2PRelayState[] {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const statuses = pool?.listConnectionStatus() ?? new Map<string, boolean>();
  const connected = new Set<string>();
  for (const [relayUrl, isConnected] of statuses.entries()) {
    if (isConnected) {
      connected.add(normalizeRelay(relayUrl));
    }
  }

  return currentRelays.map((relay) => {
    const normalized = normalizeRelay(relay);
    if (connected.has(normalized)) {
      return { url: relay, status: 'connected' };
    }
    if (controller && online) {
      return { url: relay, status: 'connecting' };
    }
    return { url: relay, status: 'disconnected' };
  });
}

function updateDebugState(): void {
  const peers = controller?.getPeerStats().map(peer => ({
    peerId: peer.peerId,
    pubkey: peer.pubkey,
    connected: peer.connected,
    pool: peer.pool,
    bytesSent: peer.bytesSent,
    bytesReceived: peer.bytesReceived,
    requestsSent: peer.requestsSent,
    requestsReceived: peer.requestsReceived,
    responsesSent: peer.responsesSent,
    responsesReceived: peer.responsesReceived,
    forwardedRequests: peer.forwardedRequests,
    forwardedResolved: peer.forwardedResolved,
    forwardedSuppressed: peer.forwardedSuppressed,
  })) ?? [];
  const relays = getRelayStates();
  const connectedRelayCount = relays.filter(relay => relay.status === 'connected').length;

  const state: P2PState = {
    started: !!controller,
    peerCount: peers.filter(peer => peer.connected).length,
    relayCount: currentRelays.length,
    connectedRelayCount,
    pubkey: publicKey,
    peers,
    relays,
    blossomBandwidth: {
      totalBytesSent: currentBlossomBandwidth.totalBytesSent,
      totalBytesReceived: currentBlossomBandwidth.totalBytesReceived,
      updatedAt: currentBlossomBandwidth.updatedAt,
      servers: currentBlossomBandwidth.servers.map(server => ({ ...server })),
    },
  };
  p2pStore.set(state);
  if (typeof window !== 'undefined') {
    window.__hashtreeCcP2P = state;
  }
}

function setupBlossomBandwidthSync(): void {
  if (blossomBandwidthUnsubscribe) return;
  blossomBandwidthUnsubscribe = blossomBandwidthStore.subscribe((stats) => {
    currentBlossomBandwidth = {
      totalBytesSent: stats.totalBytesSent,
      totalBytesReceived: stats.totalBytesReceived,
      updatedAt: stats.updatedAt,
      servers: stats.servers.map(server => ({
        url: server.url,
        bytesSent: server.bytesSent,
        bytesReceived: server.bytesReceived,
      })),
    };
    updateDebugState();
  });
}

function handleSignalingEvent(event: Event): void {
  if (!controller) {
    return;
  }

  void (async () => {
    const decoded = await decodeSignalingEvent({
      event,
      giftUnwrap: giftUnwrapEvent,
    });
    if (!decoded) {
      return;
    }
    await controller?.handleSignalingMessage(decoded.message, decoded.senderPubkey);
  })();
}

async function publishEvent(event: Event): Promise<void> {
  if (!pool) return;
  const publishes = pool.publish(currentRelays, event);
  await Promise.allSettled(publishes);
}

async function signLocalEvent(template: SignalingTemplate): Promise<Event> {
  if (!secretKey) {
    throw new Error('No local secret key available for WebRTC signaling');
  }
  return finalizeEvent(template, secretKey) as Event;
}

async function giftWrapMessage(innerEvent: SignalingInnerEvent, recipientPubkey: string): Promise<Event> {
  if (!secretKey || !publicKey) {
    throw new Error('No local keypair available for WebRTC signaling');
  }

  const seal: GiftSeal = {
    pubkey: publicKey,
    kind: innerEvent.kind,
    content: innerEvent.content,
    tags: innerEvent.tags,
  };

  const ephemeralSk = generateSecretKey();
  const createdAt = Math.floor(Date.now() / 1000);
  const expiration = createdAt + 5 * 60;
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, recipientPubkey);
  const encryptedContent = nip44.v2.encrypt(JSON.stringify(seal), conversationKey);

  return finalizeEvent({
    kind: SIGNALING_KIND,
    created_at: createdAt,
    tags: [
      ['p', recipientPubkey],
      ['expiration', String(expiration)],
    ],
    content: encryptedContent,
  }, ephemeralSk) as Event;
}

async function giftUnwrapEvent(event: Event): Promise<GiftSeal | null> {
  if (!secretKey) {
    return null;
  }
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, event.pubkey);
    const decrypted = nip44.v2.decrypt(event.content, conversationKey);
    return JSON.parse(decrypted) as GiftSeal;
  } catch {
    return null;
  }
}

async function sendSignaling(msg: SignalingMessage, recipientPubkey?: string): Promise<void> {
  if (!secretKey) {
    return;
  }
  await sendSignalingMessage({
    msg,
    recipientPubkey,
    signEvent: signLocalEvent,
    giftWrap: giftWrapMessage,
    publish: publishEvent,
  });
}

function setupSubscriptions(relays: string[]): void {
  if (!pool || !publicKey) return;
  for (const sub of subscriptions) {
    sub.close();
  }
  subscriptions = [];

  const { helloFilter, directedFilter } = createSignalingFilters(publicKey);
  const helloSub = pool.subscribe(relays, helloFilter, {
    onevent: handleSignalingEvent,
  });
  const directedSub = pool.subscribe(relays, directedFilter, {
    onevent: handleSignalingEvent,
  });
  subscriptions = [helloSub, directedSub];
}

async function createLocalStoreAdapter(): Promise<Store> {
  return {
    put: async (hash, data) => {
      const expectedHash = toHex(hash);
      const stored = await putBlob(data, 'application/octet-stream', false);
      return stored.hashHex === expectedHash;
    },
    get: async (hash) => {
      return withLocalStoreReadGuard(async () => {
        return getBlobForPeer(toHex(hash));
      });
    },
    has: async (hash) => {
      return withLocalStoreReadGuard(async () => {
        const data = await getBlobForPeer(toHex(hash));
        return !!data;
      });
    },
    delete: async () => false,
  };
}

function setupSettingsSync(): void {
  if (settingsUnsubscribe) return;
  let lastRelaysKey = '';
  settingsUnsubscribe = settingsStore.subscribe((settings) => {
    const nextRelays = normalizeRelays(settings.network.relays);
    const key = nextRelays.join(',');
    if (key === lastRelaysKey) return;
    lastRelaysKey = key;
    currentRelays = nextRelays;
    setupSubscriptions(currentRelays);
    updateDebugState();
  });
}

async function withLocalStoreReadGuard<T>(read: () => Promise<T>): Promise<T> {
  localStoreReadDepth += 1;
  try {
    return await read();
  } finally {
    localStoreReadDepth -= 1;
  }
}

async function fetchFromPeersForWorker(hashHex: string): Promise<Uint8Array | null> {
  if (localStoreReadDepth > 0) {
    return null;
  }

  await initP2P();
  if (!controller) {
    return null;
  }
  return controller.get(fromHex(hashHex));
}

setP2PFetchHandler(fetchFromPeersForWorker);

export async function initP2P(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const settings = settingsStore.getState();
    currentRelays = normalizeRelays(settings.network.relays);
    secretKey = generateSecretKey();
    publicKey = getPublicKey(secretKey);
    pool = new SimplePool();

    const localStore = await createLocalStoreAdapter();
    proxy = new WebRTCProxy((event) => {
      controller?.handleProxyEvent(event);
    });
    controller = new WebRTCController({
      pubkey: publicKey,
      localStore,
      sendCommand: (cmd) => {
        proxy?.handleCommand(cmd);
      },
      sendSignaling,
      getFollows: () => new Set<string>(),
      requestTimeout: 1500,
      debug: false,
    });
    controller.start();
    setupSubscriptions(currentRelays);
    setupSettingsSync();
    setupBlossomBandwidthSync();

    if (!statsTimer) {
      statsTimer = setInterval(updateDebugState, STATS_INTERVAL_MS);
    }
    updateDebugState();
  })();

  return initPromise;
}

export async function getFromP2P(hashHex: string): Promise<Uint8Array | null> {
  await initP2P();
  if (!controller) return null;
  return controller.get(fromHex(hashHex));
}
