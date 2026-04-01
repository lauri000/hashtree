/**
 * @hashtree/nostr - Nostr integration for hashtree
 *
 * Provides WebRTC P2P storage and Nostr ref resolver
 */

// WebRTC P2P store
export {
  WebRTCStore,
  DEFAULT_RELAYS,
  Peer,
  PeerSelector,
  PeerId,
  generateUuid,
  MAX_HTL,
  MSG_TYPE_REQUEST,
  MSG_TYPE_RESPONSE,
  FRAGMENT_SIZE,
  // Protocol functions
  encodeRequest,
  encodeResponse,
  parseMessage,
  createRequest,
  createResponse,
  createFragmentResponse,
  hashToKey,
  verifyHash,
  generatePeerHTLConfig,
  decrementHTLWithPolicy,
  decrementHTL,
  shouldForwardHTL,
  peerPrincipal,
  normalizeDispatchConfig,
  buildHedgedWavePlan,
  syncSelectorPeers,
  shouldForward,
  type SignalingMessage,
  type WebRTCStoreConfig,
  type PeerStatus,
  type WebRTCStoreEvent,
  type WebRTCStoreEventHandler,
  type EventSigner,
  type EventEncrypter,
  type EventDecrypter,
  type GiftWrapper,
  type GiftUnwrapper,
  type SignedEvent,
  type PeerPool,
  type PeerClassifier,
  type PoolConfig,
  type SelectionStrategy,
  type RequestDispatchConfig,
  type PersistedPeerMetadata,
  type PeerMetadataSnapshot,
  type MeshStats,
  type WebRTCStats,
  type BandwidthSample,
  type DataRequest,
  type DataResponse,
  type PeerHTLConfig,
  type PendingRequest,
} from './webrtc/index.js';

// Ref resolvers
export {
  createNostrRefResolver,
  // Legacy alias
  createNostrRefResolver as createNostrRootResolver,
  type NostrRefResolverConfig,
  // Legacy alias
  type NostrRefResolverConfig as NostrRootResolverConfig,
  type NostrEvent,
  type NostrFilter,
  type Nip19Like,
  type VisibilityCallbacks,
  type ParsedTreeVisibility,
} from './resolver/index.js';

// Event storage and indexing
export {
  NostrEventStore,
  type StoredNostrEvent,
  type NostrEventManifest,
  type ListEventsOptions,
} from './events.js';

export {
  encodeSignedNostrEventJson,
  decodeSignedNostrEventJson,
  storeSignedNostrEventSnapshot,
  readSignedNostrEventSnapshot,
  parseHashtreeRootEvent,
  type ParsedHashtreeRootEvent,
} from './snapshot.js';
