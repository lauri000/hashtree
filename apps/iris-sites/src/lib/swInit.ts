import { registerSW } from 'virtual:pwa-register';

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

  registerSW({
    immediate: true,
  });

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
}
