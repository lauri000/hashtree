import { writable } from 'svelte/store';

const MIN_VISIBLE_MS = 500;

export const localSaveInProgressStore = writable(false);

let activeSaves = 0;
let visibleSince = 0;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimer(): void {
  if (!clearTimer) return;
  clearTimeout(clearTimer);
  clearTimer = null;
}

export function beginLocalSaveProgress(): void {
  activeSaves += 1;
  clearPendingTimer();

  if (activeSaves === 1) {
    visibleSince = Date.now();
    localSaveInProgressStore.set(true);
  }
}

export function endLocalSaveProgress(): void {
  if (activeSaves === 0) return;
  activeSaves -= 1;
  if (activeSaves > 0) return;

  const elapsedMs = Date.now() - visibleSince;
  const remainingMs = Math.max(0, MIN_VISIBLE_MS - elapsedMs);

  if (remainingMs === 0) {
    localSaveInProgressStore.set(false);
    return;
  }

  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (activeSaves === 0) {
      localSaveInProgressStore.set(false);
    }
  }, remainingMs);
}
