import { get, writable } from 'svelte/store';

export interface UploadEntry {
  nhash: string;
  fileName: string;
  size: number;
  uploadedAt: number;
}

const STORAGE_KEY = 'hashtree-cc-uploads';
const MAX_ENTRIES = 100;

function load(): UploadEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persist(entries: UploadEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore persistence errors.
  }
}

function createUploadHistoryStore() {
  const store = writable<UploadEntry[]>(load());
  const { subscribe, update } = store;

  return {
    subscribe,

    add(entry: UploadEntry) {
      update((entries) => {
        const next = [entry, ...entries.filter((e) => e.nhash !== entry.nhash)].slice(0, MAX_ENTRIES);
        persist(next);
        return next;
      });
    },

    remove(nhash: string) {
      update((entries) => {
        const next = entries.filter((e) => e.nhash !== nhash);
        persist(next);
        return next;
      });
    },

    clear() {
      persist([]);
      update(() => []);
    },

    getState: (): UploadEntry[] => get(store),
  };
}

export const uploadHistoryStore = createUploadHistoryStore();
