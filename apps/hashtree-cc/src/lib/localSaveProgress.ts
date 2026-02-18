import { writable } from 'svelte/store';

const MIN_VISIBLE_MS = 500;

export type LocalSavePhase = 'reading' | 'writing' | 'finalizing';

export interface LocalSaveProgressState {
  bytesSaved: number;
  totalBytes: number;
  phase: LocalSavePhase;
}

export const localSaveProgressStore = writable<LocalSaveProgressState | null>(null);

let activeSaves = 0;
let visibleSince = 0;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let currentState: LocalSaveProgressState | null = null;

function clearPendingTimer(): void {
  if (!clearTimer) return;
  clearTimeout(clearTimer);
  clearTimer = null;
}

function emitState(next: LocalSaveProgressState | null): void {
  currentState = next;
  localSaveProgressStore.set(next);
}

export function beginLocalSaveProgress(totalBytes: number): void {
  activeSaves += 1;
  clearPendingTimer();

  if (activeSaves === 1) {
    visibleSince = Date.now();
    emitState({
      bytesSaved: 0,
      totalBytes: Math.max(0, totalBytes),
      phase: 'reading',
    });
  }
}

export function updateLocalSaveProgress(bytesSaved: number, totalBytes?: number): void {
  if (!currentState) return;

  const nextTotal = totalBytes === undefined
    ? currentState.totalBytes
    : Math.max(0, totalBytes);
  const nextBytes = Math.max(0, Math.min(bytesSaved, nextTotal || bytesSaved));

  emitState({
    bytesSaved: nextBytes,
    totalBytes: nextTotal,
    phase: 'writing',
  });
}

export function setLocalSavePhase(phase: LocalSavePhase): void {
  if (!currentState) return;
  emitState({ ...currentState, phase });
}

export function endLocalSaveProgress(): void {
  if (activeSaves === 0) return;
  activeSaves -= 1;
  if (activeSaves > 0) return;

  const elapsedMs = Date.now() - visibleSince;
  const remainingMs = Math.max(0, MIN_VISIBLE_MS - elapsedMs);

  if (remainingMs === 0) {
    emitState(null);
    return;
  }

  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (activeSaves === 0) {
      emitState(null);
    }
  }, remainingMs);
}
