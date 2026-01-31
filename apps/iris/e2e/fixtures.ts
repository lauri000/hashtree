import { test as base, type Page } from '@playwright/test';

/**
 * Mock Tauri IPC so the shell UI can render in a regular browser.
 *
 * We intercept `window.__TAURI_INTERNALS__.invoke` and `window.__TAURI_INTERNALS__.transformCallback`
 * before the app boots so that calls like createNip07Webview / closeWebview don't throw.
 */
async function mockTauriIPC(page: Page) {
  await page.addInitScript(() => {
    // Track invocations for assertions
    (window as any).__tauriInvocations = [] as Array<{ cmd: string; args: any }>;

    const ipc = {
      invoke(cmd: string, args: any) {
        (window as any).__tauriInvocations.push({ cmd, args });

        // Return sensible defaults per command
        switch (cmd) {
          case 'create_nip07_webview':
          case 'create_htree_webview':
          case 'close_webview':
          case 'navigate_webview':
          case 'webview_history':
          case 'record_history_visit':
            return Promise.resolve();
          case 'get_htree_server_url':
            return Promise.resolve('http://127.0.0.1:21417');
          case 'webview_current_url':
            return Promise.resolve('about:blank');
          case 'search_history':
          case 'get_recent_history':
            return Promise.resolve([]);
          default:
            return Promise.resolve(null);
        }
      },
      transformCallback(callback: Function, once: boolean) {
        const id = Math.random();
        (window as any)[`_${id}`] = callback;
        return id;
      },
      convertFileSrc(path: string) {
        return path;
      },
    };

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: ipc,
      writable: false,
      configurable: true,
    });
  });
}

export const test = base.extend<{ tauriPage: Page }>({
  tauriPage: async ({ page }, use) => {
    await mockTauriIPC(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';

/** Get the list of Tauri IPC invocations recorded during the test. */
export async function getTauriInvocations(page: Page): Promise<Array<{ cmd: string; args: any }>> {
  return page.evaluate(() => (window as any).__tauriInvocations ?? []);
}

/** Get invocations for a specific command. */
export async function getInvocationsFor(page: Page, cmd: string): Promise<Array<{ cmd: string; args: any }>> {
  const all = await getTauriInvocations(page);
  return all.filter((i) => i.cmd === cmd);
}
