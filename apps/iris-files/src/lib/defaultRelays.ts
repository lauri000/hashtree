const RELAY_DAMUS = 'wss://relay.damus.io';
const RELAY_PRIMAL = 'wss://relay.primal.net';
const RELAY_NOSTR_BAND = 'wss://relay.nostr.band';
const RELAY_SNORT = 'wss://relay.snort.social';
const RELAY_TEMP = 'wss://temp.iris.to';
const RELAY_OFFCHAIN = 'wss://offchain.pub';

const IRIS_FILES_BASE_RELAYS = [
  RELAY_DAMUS,
  RELAY_PRIMAL,
  RELAY_NOSTR_BAND,
  RELAY_SNORT,
  RELAY_TEMP,
  RELAY_OFFCHAIN,
];

export const DEFAULT_PUBLIC_RELAYS = [...IRIS_FILES_BASE_RELAYS];

export const DEFAULT_TREE_ROOT_RELAYS = [...IRIS_FILES_BASE_RELAYS];

export const DEFAULT_HISTORY_RELAYS = [
  RELAY_DAMUS,
  RELAY_OFFCHAIN,
  RELAY_PRIMAL,
  RELAY_NOSTR_BAND,
  RELAY_SNORT,
  RELAY_TEMP,
];

export const DEFAULT_E2E_PRODUCTION_RELAYS = IRIS_FILES_BASE_RELAYS.filter(
  (relay) => relay !== RELAY_OFFCHAIN,
);
