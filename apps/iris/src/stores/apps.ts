import { writable } from 'svelte/store';
import { cloneBookmarks, defaultFavoriteApps, type AppBookmark } from '../lib/apps';

const STORAGE_KEY = 'iris:apps';

function loadApps(): AppBookmark[] {
  if (typeof localStorage === 'undefined') return cloneBookmarks(defaultFavoriteApps);
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return cloneBookmarks(defaultFavoriteApps);
    return JSON.parse(stored);
  } catch {
    return cloneBookmarks(defaultFavoriteApps);
  }
}

function saveApps(apps: AppBookmark[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(apps));
  } catch {
    // Ignore storage errors
  }
}

function createAppsStore() {
  const { subscribe, set, update } = writable<AppBookmark[]>(loadApps());

  return {
    subscribe,

    add(app: AppBookmark) {
      update((apps) => {
        if (apps.some((a) => a.url === app.url)) return apps;
        const newApps = [...apps, app];
        saveApps(newApps);
        return newApps;
      });
    },

    remove(url: string) {
      update((apps) => {
        const newApps = apps.filter((a) => a.url !== url);
        saveApps(newApps);
        return newApps;
      });
    },

    clear() {
      set([]);
      saveApps([]);
    },
  };
}

export const appsStore = createAppsStore();
