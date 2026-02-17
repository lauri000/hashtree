import { registerMediaPort } from './workerClient';

let isSetup = false;
let setupPromise: Promise<boolean> | null = null;
let activeController: ServiceWorker | null = null;
let controllerListenerAttached = false;

function attachControllerListener(): void {
  if (controllerListenerAttached || !('serviceWorker' in navigator)) return;
  controllerListenerAttached = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    isSetup = false;
    setupPromise = null;
    activeController = null;
  });
}

async function waitForController(timeoutMs: number): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  await navigator.serviceWorker.ready.catch(() => {});
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise<ServiceWorker | null>((resolve) => {
    const timeoutId = setTimeout(() => resolve(navigator.serviceWorker.controller ?? null), timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timeoutId);
      resolve(navigator.serviceWorker.controller ?? null);
    }, { once: true });
  });
}

async function setupWithController(controller: ServiceWorker): Promise<boolean> {
  const setupId = `hashtree-cc-media-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const channel = new MessageChannel();

  const ackPromise = new Promise<boolean>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string } | undefined;
      if (data?.type === 'WORKER_PORT_READY' && data.requestId === setupId) {
        cleanup();
        resolve(true);
      }
    };
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
    timeoutId = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 5000);
    navigator.serviceWorker.addEventListener('message', onMessage);
  });

  controller.postMessage({
    type: 'REGISTER_WORKER_PORT',
    requestId: setupId,
    port: channel.port1,
  }, [channel.port1]);

  await registerMediaPort(channel.port2);
  const ok = await ackPromise;
  if (ok) {
    isSetup = true;
    activeController = controller;
  }
  return ok;
}

export async function setupMediaStreaming(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  attachControllerListener();

  const controller = await waitForController(5000);
  if (!controller) return false;
  if (isSetup && activeController === controller) return true;
  if (setupPromise) return setupPromise;

  setupPromise = setupWithController(controller).then((ok) => {
    if (!ok) {
      setupPromise = null;
    }
    return ok;
  });
  return setupPromise;
}
