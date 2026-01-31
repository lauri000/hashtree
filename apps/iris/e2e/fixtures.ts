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

    // Mutable in-memory history store — record_history_visit adds entries,
    // get_recent_history / search_history read from it.
    const historyStore: Array<{
      path: string; label: string; entry_type: string;
      npub?: string; tree_name?: string;
      visit_count: number; last_visited: number; first_visited: number;
    }> = [];
    (window as any).__historyStore = historyStore;

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
          case 'reload_webview':
            return Promise.resolve();
          case 'record_history_visit': {
            const now = Date.now();
            const existing = historyStore.find(e => e.path === args?.path);
            if (existing) {
              existing.visit_count++;
              existing.last_visited = now;
              existing.label = args?.label ?? existing.label;
            } else {
              historyStore.push({
                path: args?.path ?? '',
                label: args?.label ?? '',
                entry_type: args?.entry_type ?? 'web',
                npub: args?.npub,
                tree_name: args?.tree_name,
                visit_count: 1,
                last_visited: now,
                first_visited: now,
              });
            }
            return Promise.resolve();
          }
          case 'get_htree_server_url':
            return Promise.resolve('http://127.0.0.1:21417');
          case 'webview_current_url':
            return Promise.resolve('about:blank');
          case 'get_recent_history': {
            const sorted = [...historyStore].sort((a, b) => b.last_visited - a.last_visited);
            return Promise.resolve(sorted.slice(0, args?.limit ?? 20));
          }
          case 'search_history': {
            const query = (args?.query ?? '').toLowerCase();
            const limit = args?.limit ?? 10;
            const matches = historyStore
              .filter(e => e.label.toLowerCase().includes(query) || e.path.toLowerCase().includes(query))
              .slice(0, limit)
              .map(entry => ({ entry, score: 5.0 }));
            return Promise.resolve(matches);
          }
          case 'delete_history_entry': {
            const idx = historyStore.findIndex(e => e.path === args?.path);
            if (idx >= 0) { historyStore.splice(idx, 1); return Promise.resolve(true); }
            return Promise.resolve(false);
          }
          case 'clear_history':
            historyStore.length = 0;
            return Promise.resolve();
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

export function setupPageErrorHandler(page: Page) {
  page.on('pageerror', (err: Error) => {
    const msg = err.message;
    if (!msg.includes('rate-limited') && !msg.includes('pow:') && !msg.includes('bits needed')) {
      console.log('Page error:', msg);
    }
  });
}

export async function disableOthersPool(_page: Page) {
  // Iris shell has no WebRTC pools; keep as no-op for shared test conventions.
}

export async function gotoHome(page: Page) {
  await page.goto('/');
  await disableOthersPool(page);
}

/** Get the list of Tauri IPC invocations recorded during the test. */
export async function getTauriInvocations(page: Page): Promise<Array<{ cmd: string; args: any }>> {
  return page.evaluate(() => (window as any).__tauriInvocations ?? []);
}

/** Get invocations for a specific command. */
export async function getInvocationsFor(page: Page, cmd: string): Promise<Array<{ cmd: string; args: any }>> {
  const all = await getTauriInvocations(page);
  return all.filter((i) => i.cmd === cmd);
}
