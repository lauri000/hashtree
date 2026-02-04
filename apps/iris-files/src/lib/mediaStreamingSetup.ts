/**
 * Media Streaming Setup
 *
 * Sets up the MessageChannel between service worker and hashtree worker
 * to enable media streaming via /media/{cid}/{path} URLs.
 */

import { getMediaClientId } from './mediaClient';
import { isHtreeDebugEnabled, logHtreeDebug } from './htreeDebug';
import { getWorkerAdapter, waitForWorkerAdapter } from './workerInit';

let isSetup = false;
let setupPromise: Promise<boolean> | null = null;
let activeController: ServiceWorker | null = null;
let controllerListenerAttached = false;

function ensureControllerListener(): void {
  if (controllerListenerAttached || !('serviceWorker' in navigator)) return;
  controllerListenerAttached = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    resetMediaStreaming();
  });
}

/**
 * Setup media streaming by connecting service worker to hashtree worker
 *
 * This creates a MessageChannel and:
 * 1. Sends one port to the service worker
 * 2. Sends the other port to the hashtree worker
 *
 * The service worker can then request media data directly from the worker.
 */
export async function setupMediaStreaming(): Promise<boolean> {
  logHtreeDebug('media:setup:begin', {
    isSetup,
    hasController: typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller,
  });
  if ('serviceWorker' in navigator) {
    ensureControllerListener();
    const controller = navigator.serviceWorker.controller;
    if (isSetup && activeController && controller && controller !== activeController) {
      logHtreeDebug('media:setup:controller-change');
      resetMediaStreaming();
    } else if (isSetup && controller) {
      const clientKey = getMediaClientId();
      if (clientKey) {
        const ok = await pingWorkerPort(clientKey, controller);
        if (!ok) {
          logHtreeDebug('media:setup:ping-failed', { clientKey });
          resetMediaStreaming();
        }
      }
    }
  }

  if (isSetup) return true;
  if (setupPromise) return setupPromise;

  setupPromise = doSetup().then((result) => {
    if (!result) setupPromise = null;
    return result;
  });
  return setupPromise;
}

export async function ensureMediaStreamingReady(attempts = 3, delayMs = 500): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    logHtreeDebug('media:ensure:attempt', { attempt: attempt + 1, attempts });
    const ready = await setupMediaStreaming().catch(() => false);
    if (ready) {
      logHtreeDebug('media:ensure:ready', { attempt: attempt + 1 });
      return true;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  logHtreeDebug('media:ensure:failed', { attempts });
  return false;
}

async function waitForController(timeoutMs: number): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

  await navigator.serviceWorker.ready.catch(() => {});
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

  return new Promise<ServiceWorker | null>((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve(navigator.serviceWorker.controller ?? null);
    }, timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timeoutId);
      resolve(navigator.serviceWorker.controller ?? null);
    }, { once: true });
  });
}

async function pingWorkerPort(clientKey: string, controller: ServiceWorker): Promise<boolean> {
  const pingId = `media-ping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ackPromise = new Promise<boolean>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; ok?: boolean };
      if (data?.type === 'WORKER_PORT_PONG' && data.requestId === pingId) {
        cleanup();
        resolve(!!data.ok);
      }
    };
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      navigator.serviceWorker.removeEventListener('message', handler);
    };
    timeoutId = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 1500);
    navigator.serviceWorker.addEventListener('message', handler);
  });

  controller.postMessage({ type: 'PING_WORKER_PORT', requestId: pingId, clientKey });
  return await ackPromise;
}

async function doSetup(): Promise<boolean> {
  const debugEnabled = isHtreeDebugEnabled();
  // Check service worker support
  if (!('serviceWorker' in navigator)) {
    console.warn('[MediaStreaming] Service workers not supported');
    logHtreeDebug('media:setup:no-sw');
    return false;
  }

  try {
    // Get current registration status
    const currentReg = await navigator.serviceWorker.getRegistration();
    console.log('[MediaStreaming] Current registration:', currentReg?.scope, 'active:', !!currentReg?.active);
    logHtreeDebug('media:setup:registration', {
      scope: currentReg?.scope ?? null,
      hasActive: !!currentReg?.active,
    });

    // If no registration, wait for it with retries
    let registration: ServiceWorkerRegistration | null = null;
    for (let i = 0; i < 10; i++) {
      registration = await navigator.serviceWorker.getRegistration();
      if (registration?.active) {
        break;
      }
      console.log('[MediaStreaming] Waiting for SW activation, attempt', i + 1);
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!registration?.active) {
      // Try navigator.serviceWorker.ready as last resort
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 3000);
      });
      registration = (await Promise.race([
        navigator.serviceWorker.ready,
        timeoutPromise,
      ])) as ServiceWorkerRegistration | null;
    }

    if (!registration?.active) {
      console.warn('[MediaStreaming] No active service worker after retries');
      logHtreeDebug('media:setup:no-active-sw');
      return false;
    }

    const controller = await waitForController(5000);
    if (!controller) {
      console.warn('[MediaStreaming] No controlling service worker');
      logHtreeDebug('media:setup:no-controller');
      return false;
    }

    console.log('[MediaStreaming] SW active:', registration.scope);

    // Get the worker adapter
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
    if (!adapter) {
      console.warn('[MediaStreaming] Worker adapter not initialized');
      logHtreeDebug('media:setup:no-worker-adapter');
      return false;
    }

    // Create a MessageChannel
    const channel = new MessageChannel();

    const setupId = `media-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ackPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const handler = (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: string };
        if (data?.type === 'WORKER_PORT_READY' && data.requestId === setupId) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        navigator.serviceWorker.removeEventListener('message', handler);
      };
      timeoutId = setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve(false);
      }, 5000);
      navigator.serviceWorker.addEventListener('message', handler);
    });

    const clientKey = getMediaClientId();

    // Send one port to the service worker
    controller.postMessage(
      { type: 'REGISTER_WORKER_PORT', port: channel.port1, requestId: setupId, clientKey, debug: debugEnabled },
      [channel.port1]
    );

    // Send the other port to the hashtree worker
    adapter.registerMediaPort(channel.port2, debugEnabled);
    logHtreeDebug('media:setup:register', { clientKey: clientKey ?? null, debug: debugEnabled });

    const acked = await ackPromise;
    if (!acked) {
      console.warn('[MediaStreaming] No ack from service worker');
      logHtreeDebug('media:setup:no-ack');
      return false;
    }

    isSetup = true;
    activeController = controller;
    console.log('[MediaStreaming] Setup complete');
    logHtreeDebug('media:setup:complete');
    return true;
  } catch (error) {
    console.error('[MediaStreaming] Setup failed:', error);
    logHtreeDebug('media:setup:error', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Check if media streaming is set up
 */
export function isMediaStreamingSetup(): boolean {
  return isSetup;
}

/**
 * Reset media streaming (for testing/cleanup)
 */
export function resetMediaStreaming(): void {
  isSetup = false;
  setupPromise = null;
  activeController = null;
}
