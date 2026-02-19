import { registerSW } from 'virtual:pwa-register';
import { get } from 'svelte/store';
import { localSaveProgressStore } from './localSaveProgress';
import { uploadProgressStore } from './workerClient';

const UPDATE_POLL_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_RETRY_INTERVAL_MS = 3_000;

interface TransferActivityMessage {
  type?: string;
  requestId?: string;
  activeDownloads?: number;
}

function hasActiveUploadTransfers(): boolean {
  if (get(localSaveProgressStore)) {
    return true;
  }

  const uploadProgress = get(uploadProgressStore);
  return !!uploadProgress && !uploadProgress.complete;
}

async function hasActiveDownloadTransfers(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    return false;
  }

  const requestId = `sw-transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as TransferActivityMessage | undefined;
      if (message?.type !== 'TRANSFER_ACTIVITY' || message.requestId !== requestId) {
        return;
      }
      settled = true;
      cleanup();
      resolve((message.activeDownloads ?? 0) > 0);
    };

    const cleanup = () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      clearTimeout(timeoutId);
    };

    const timeoutId = setTimeout(() => {
      if (settled) return;
      cleanup();
      resolve(false);
    }, 1000);

    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.controller?.postMessage({
      type: 'GET_TRANSFER_ACTIVITY',
      requestId,
    });
  });
}

async function hasActiveTransfers(): Promise<boolean> {
  if (hasActiveUploadTransfers()) {
    return true;
  }
  return hasActiveDownloadTransfers();
}

/**
 * Register the app service worker and wait until it controls the page.
 */
export async function initServiceWorker(): Promise<void> {
  const isTestMode = !!import.meta.env.VITE_TEST_MODE;

  if (!('serviceWorker' in navigator)) {
    return;
  }

  if (isTestMode) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => {})));
    } catch {
      // Ignore cleanup failures in tests.
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key).catch(() => {})));
    } catch {
      // Ignore cleanup failures in tests.
    }
  }

  let updatePending = false;
  let updateInFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let updateCheckTimer: ReturnType<typeof setInterval> | null = null;

  const scheduleRetry = (updateNow: () => Promise<void>) => {
    if (retryTimer || !updatePending) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void updateNow();
    }, UPDATE_RETRY_INTERVAL_MS);
  };

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (isTestMode || !registration || updateCheckTimer) return;
      updateCheckTimer = setInterval(() => {
        void registration.update().catch(() => {});
      }, UPDATE_POLL_INTERVAL_MS);
    },
    onNeedRefresh() {
      updatePending = true;
      void activateWhenIdle();
    },
  });

  const activateWhenIdle = async () => {
    if (isTestMode || !updatePending || updateInFlight) return;

    const busy = await hasActiveTransfers().catch(() => false);
    if (busy) {
      scheduleRetry(activateWhenIdle);
      return;
    }

    updateInFlight = true;
    try {
      await updateSW(true);
      updatePending = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    } catch {
      scheduleRetry(activateWhenIdle);
    } finally {
      updateInFlight = false;
    }
  };

  if (!navigator.serviceWorker.controller) {
    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
      const gotController = await Promise.race([
        new Promise<boolean>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
      ]);

      if (!gotController && !navigator.serviceWorker.controller) {
        window.location.reload();
        return new Promise(() => {});
      }
    }
  }

  // No forced reload on controller changes. Updates are applied on next open.
}
