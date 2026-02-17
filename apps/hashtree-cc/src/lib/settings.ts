import { get, writable } from 'svelte/store';
import type { BlossomServerConfig } from '@hashtree/worker';

export interface HashtreeCcSettings {
  network: {
    relays: string[];
    blossomServers: BlossomServerConfig[];
  };
  storage: {
    maxBytes: number;
  };
  ui: {
    showBandwidthIndicator: boolean;
  };
}

const SETTINGS_KEY = 'hashtree-cc-settings-v1';
const MB = 1024 * 1024;

export const DEFAULT_SETTINGS: HashtreeCcSettings = {
  network: {
    relays: [
      'wss://relay.primal.net',
      'wss://temp.iris.to',
      'wss://relay.damus.io',
      'wss://relay.snort.social',
      'wss://offchain.pub',
    ],
    blossomServers: [
      { url: 'https://cdn.iris.to', read: true, write: false },
      { url: 'https://upload.iris.to', read: false, write: true },
      { url: 'https://blossom.primal.net', read: true, write: true },
    ],
  },
  storage: {
    maxBytes: 1024 * MB,
  },
  ui: {
    showBandwidthIndicator: false,
  },
};

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function normalizeServer(server: BlossomServerConfig): BlossomServerConfig | null {
  const url = normalizeUrl(server.url);
  if (!url) return null;
  return {
    url,
    read: server.read ?? true,
    write: server.write ?? false,
  };
}

function normalizeSettings(raw: unknown): HashtreeCcSettings {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_SETTINGS;
  }
  const candidate = raw as Partial<HashtreeCcSettings>;
  const rawRelays = candidate.network?.relays ?? [];
  const relays = rawRelays
    .map(normalizeUrl)
    .filter(Boolean);
  const rawServers = candidate.network?.blossomServers ?? [];
  const servers = rawServers
    .map(normalizeServer)
    .filter((server): server is BlossomServerConfig => !!server);

  const maxBytes = Number(candidate.storage?.maxBytes);
  const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes >= 100 * MB
    ? Math.round(maxBytes)
    : DEFAULT_SETTINGS.storage.maxBytes;
  const showBandwidthIndicator = typeof candidate.ui?.showBandwidthIndicator === 'boolean'
    ? candidate.ui.showBandwidthIndicator
    : DEFAULT_SETTINGS.ui.showBandwidthIndicator;

  return {
    network: {
      relays: relays.length > 0 ? relays : DEFAULT_SETTINGS.network.relays,
      blossomServers: servers.length > 0 ? servers : DEFAULT_SETTINGS.network.blossomServers,
    },
    storage: {
      maxBytes: normalizedMaxBytes,
    },
    ui: {
      showBandwidthIndicator,
    },
  };
}

function loadSettings(): HashtreeCcSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const stored = window.localStorage.getItem(SETTINGS_KEY);
    if (!stored) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(stored));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: HashtreeCcSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore persistence errors.
  }
}

function createSettingsStore() {
  const store = writable<HashtreeCcSettings>(loadSettings());
  const { subscribe, update } = store;

  const commit = (mutator: (settings: HashtreeCcSettings) => HashtreeCcSettings) => {
    update((current) => {
      const next = mutator(current);
      persistSettings(next);
      return next;
    });
  };

  return {
    subscribe,

    getState: (): HashtreeCcSettings => get(store),

    setStorageLimitMb: (mb: number) => {
      const boundedMb = Math.min(10_000, Math.max(100, Math.round(mb || 0)));
      commit((settings) => ({
        ...settings,
        storage: { ...settings.storage, maxBytes: boundedMb * MB },
      }));
    },

    setStorageMaxBytes: (maxBytes: number) => {
      const bounded = Math.min(10_000 * MB, Math.max(100 * MB, Math.round(maxBytes || 0)));
      commit((settings) => ({
        ...settings,
        storage: { ...settings.storage, maxBytes: bounded },
      }));
    },

    setShowBandwidthIndicator: (enabled: boolean) => {
      commit((settings) => ({
        ...settings,
        ui: {
          ...settings.ui,
          showBandwidthIndicator: enabled,
        },
      }));
    },

    addBlossomServer: (url: string) => {
      const normalized = normalizeUrl(url);
      if (!normalized) return;
      commit((settings) => {
        if (settings.network.blossomServers.some(server => server.url === normalized)) {
          return settings;
        }
        return {
          ...settings,
          network: {
            ...settings.network,
            blossomServers: [
              ...settings.network.blossomServers,
              { url: normalized, read: true, write: false },
            ],
          },
        };
      });
    },

    addRelay: (url: string) => {
      const normalized = normalizeUrl(url);
      if (!normalized) return;
      commit((settings) => {
        if (settings.network.relays.includes(normalized)) {
          return settings;
        }
        return {
          ...settings,
          network: {
            ...settings.network,
            relays: [...settings.network.relays, normalized],
          },
        };
      });
    },

    removeRelay: (url: string) => {
      const normalized = normalizeUrl(url);
      commit((settings) => ({
        ...settings,
        network: {
          ...settings.network,
          relays: settings.network.relays.filter(relay => relay !== normalized),
        },
      }));
    },

    removeBlossomServer: (url: string) => {
      const normalized = normalizeUrl(url);
      commit((settings) => ({
        ...settings,
        network: {
          ...settings.network,
          blossomServers: settings.network.blossomServers.filter(server => server.url !== normalized),
        },
      }));
    },

    toggleBlossomServerRead: (url: string) => {
      const normalized = normalizeUrl(url);
      commit((settings) => ({
        ...settings,
        network: {
          ...settings.network,
          blossomServers: settings.network.blossomServers.map((server) => (
            server.url === normalized ? { ...server, read: !(server.read ?? true) } : server
          )),
        },
      }));
    },

    toggleBlossomServerWrite: (url: string) => {
      const normalized = normalizeUrl(url);
      commit((settings) => ({
        ...settings,
        network: {
          ...settings.network,
          blossomServers: settings.network.blossomServers.map((server) => (
            server.url === normalized ? { ...server, write: !(server.write ?? false) } : server
          )),
        },
      }));
    },

    reset: () => {
      persistSettings(DEFAULT_SETTINGS);
      update(() => DEFAULT_SETTINGS);
    },
  };
}

export const settingsStore = createSettingsStore();
