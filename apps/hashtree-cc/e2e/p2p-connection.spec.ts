import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const SETTINGS_KEY = 'hashtree-cc-settings-v1';
const GB = 1024 * 1024 * 1024;

function buildSettings(relayUrl: string, blossomServers = [
  { url: 'https://blossom.primal.net', read: true, write: true },
]) {
  return {
    network: {
      relays: [relayUrl],
      blossomServers,
    },
    storage: {
      maxBytes: GB,
    },
    ui: {
      showConnectivity: true,
    },
  };
}

async function newContextWithRelay(
  browser: Browser,
  relayUrl: string,
  blossomServers = [{ url: 'https://blossom.primal.net', read: true, write: true }]
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const settings = buildSettings(relayUrl, blossomServers);
  await context.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: SETTINGS_KEY, value: settings });
  return context;
}

async function getPeerCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = (window as unknown as { __hashtreeCcP2P?: { peerCount?: number } }).__hashtreeCcP2P;
    return state?.peerCount ?? 0;
  });
}

test('two isolated sessions connect to each other over p2p', async ({ browser }) => {
  const relayNamespace = `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const relayUrl = `ws://localhost:4736/${relayNamespace}`;

  const contextA = await newContextWithRelay(browser, relayUrl);
  const contextB = await newContextWithRelay(browser, relayUrl);

  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await Promise.all([pageA.goto('/'), pageB.goto('/')]);

    await expect.poll(async () => pageA.evaluate(() => {
      const state = (window as unknown as { __hashtreeCcP2P?: { started?: boolean } }).__hashtreeCcP2P;
      return state?.started ?? false;
    })).toBe(true);

    await expect.poll(async () => pageB.evaluate(() => {
      const state = (window as unknown as { __hashtreeCcP2P?: { started?: boolean } }).__hashtreeCcP2P;
      return state?.started ?? false;
    })).toBe(true);

    await expect.poll(async () => {
      const [peerCountA, peerCountB] = await Promise.all([
        getPeerCount(pageA),
        getPeerCount(pageB),
      ]);
      return peerCountA > 0 && peerCountB > 0;
    }, { timeout: 30000 }).toBe(true);

    await expect.poll(async () => pageA.evaluate(() => {
      const icon = document.querySelector<HTMLElement>('[data-testid="connectivity-indicator"] .i-lucide-wifi');
      return icon ? getComputedStyle(icon).color : null;
    }), { timeout: 30000 }).toBe('rgb(88, 166, 255)');

    await pageA.goto('/#/settings');
    await expect(pageA.getByTestId('settings-peer-item').first()).toBeVisible();
    await expect(pageA.getByTestId('settings-relay-item').first()).toContainText('localhost');
    await expect(pageA.getByTestId('settings-relay-status-connected').first()).toBeVisible();
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});

test('viewer fetch falls back to WebRTC when blossom read servers are disabled', async ({ browser }) => {
  const relayNamespace = `p2p-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const relayUrl = `ws://localhost:4736/${relayNamespace}`;

  const contextA = await newContextWithRelay(browser, relayUrl, []);
  const contextB = await newContextWithRelay(browser, relayUrl, []);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await Promise.all([pageA.goto('/'), pageB.goto('/')]);

    await expect.poll(async () => {
      const [peerCountA, peerCountB] = await Promise.all([
        getPeerCount(pageA),
        getPeerCount(pageB),
      ]);
      return peerCountA > 0 && peerCountB > 0;
    }, { timeout: 30000 }).toBe(true);

    const content = `p2p-fallback-${Date.now()}`;
    await pageA.getByTestId('file-input').setInputFiles({
      name: 'peer-fallback.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    });
    await expect(pageA.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });

    const shareUrl = pageA.url();
    const hashPart = shareUrl.includes('#') ? shareUrl.slice(shareUrl.indexOf('#')) : '';
    expect(hashPart.startsWith('#/nhash1')).toBe(true);

    await pageB.goto(`/${hashPart}`);
    await expect(pageB.getByTestId('file-viewer')).toBeVisible({ timeout: 20000 });
    await expect(pageB.getByTestId('viewer-text')).toContainText(content, { timeout: 20000 });
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});
