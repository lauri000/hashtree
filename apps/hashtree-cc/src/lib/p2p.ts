import { fromHex, toHex, type Store } from '@hashtree/core';
import { WebRTCController, WebRTCProxy } from '@hashtree/worker/p2p';
import type { SignalingMessage } from '@hashtree/nostr';
import { SimplePool, type Event } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { writable } from 'svelte/store';
import { getBlob, getBlobForPeer, putBlob, setP2PFetchHandler } from './workerClient';
import { settingsStore } from './settings';

const SIGNALING_KIND = 25050;
const HELLO_TAG = 'hello';
const MAX_EVENT_AGE_SEC = 30;
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
}

export interface P2PState {
  started: boolean;
  peerCount: number;
  relayCount: number;
  connectedRelayCount: number;
  pubkey: string | null;
  peers: P2PPeerState[];
  relays: P2PRelayState[];
}

const DEFAULT_STATE: P2PState = {
  started: false,
  peerCount: 0,
  relayCount: 0,
  connectedRelayCount: 0,
  pubkey: null,
  peers: [],
  relays: [],
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
let initPromise: Promise<void> | null = null;
let localStoreReadDepth = 0;

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
  };
  p2pStore.set(state);
  if (typeof window !== 'undefined') {
    window.__hashtreeCcP2P = state;
  }
}

function eventExpired(event: Event): boolean {
  const nowSec = Date.now() / 1000;
  if (nowSec - event.created_at > MAX_EVENT_AGE_SEC) {
    return true;
  }
  const expirationTag = event.tags.find(tag => tag[0] === 'expiration');
  if (!expirationTag) return false;
  const expiration = Number.parseInt(expirationTag[1], 10);
  return Number.isFinite(expiration) && expiration < nowSec;
}

function parseDirectedMessage(event: Event): SignalingMessage | null {
  if (!event.content) return null;
  try {
    const parsed = JSON.parse(event.content) as SignalingMessage;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function handleSignalingEvent(event: Event): void {
  if (!controller) return;
  if (eventExpired(event)) return;

  const helloTag = event.tags.find(tag => tag[0] === 'l' && tag[1] === HELLO_TAG);
  if (helloTag) {
    const peerIdTag = event.tags.find(tag => tag[0] === 'peerId');
    if (!peerIdTag) return;
    const message: SignalingMessage = {
      type: 'hello',
      peerId: peerIdTag[1],
    };
    void controller.handleSignalingMessage(message, event.pubkey);
    return;
  }

  const directed = parseDirectedMessage(event);
  if (!directed) return;
  void controller.handleSignalingMessage(directed, event.pubkey);
}

async function publishEvent(event: Event): Promise<void> {
  if (!pool) return;
  const publishes = pool.publish(currentRelays, event);
  await Promise.allSettled(publishes);
}

async function sendSignaling(msg: SignalingMessage, recipientPubkey?: string): Promise<void> {
  if (!secretKey) return;
  const expiration = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);

  if (recipientPubkey) {
    const directedEvent = finalizeEvent({
      kind: SIGNALING_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', recipientPubkey],
        ['expiration', expiration.toString()],
      ],
      content: JSON.stringify(msg),
    }, secretKey);
    await publishEvent(directedEvent as Event);
    return;
  }

  const helloEvent = finalizeEvent({
    kind: SIGNALING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['l', HELLO_TAG],
      ['peerId', msg.peerId],
      ['expiration', expiration.toString()],
    ],
    content: '',
  }, secretKey);
  await publishEvent(helloEvent as Event);
}

function setupSubscriptions(relays: string[]): void {
  if (!pool || !publicKey) return;
  for (const sub of subscriptions) {
    sub.close();
  }
  subscriptions = [];

  const since = Math.floor((Date.now() - MAX_EVENT_AGE_SEC * 1000) / 1000);
  const helloSub = pool.subscribe(relays, {
    kinds: [SIGNALING_KIND],
    '#l': [HELLO_TAG],
    since,
  }, {
    onevent: handleSignalingEvent,
  });
  const directedSub = pool.subscribe(relays, {
    kinds: [SIGNALING_KIND],
    '#p': [publicKey],
    since,
  }, {
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
