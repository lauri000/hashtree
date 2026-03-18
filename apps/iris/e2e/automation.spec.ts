import {
  test,
  expect,
  emitTauriEvent,
  getAutomationState,
  getInvocationsFor,
  gotoHome,
  setupPageErrorHandler,
} from './fixtures';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('Automation Bridge', () => {
  test('publishes shell state snapshots', async ({ tauriPage: page }) => {
    await openHome(page);

    await page.waitForFunction(() => {
      return (window as any).__automationState?.shellReady === true;
    });

    await expect.poll(async () => {
      const state = await getAutomationState(page);
      return {
        shellReady: state.shellReady,
        currentView: state.currentView,
        canGoBack: state.canGoBack,
        historyIndex: state.historyIndex,
      };
    }).toEqual({
      shellReady: true,
      currentView: 'launcher',
      canGoBack: false,
      historyIndex: -1,
    });
  });

  test('open_url command drives normal navigation flow', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.waitForFunction(() => (window as any).__automationState?.shellReady === true);

    await emitTauriEvent(page, 'automation-command', {
      action: 'open_url',
      url: 'https://files.iris.to',
    });

    await expect.poll(async () => {
      const state = await getAutomationState(page);
      return state.currentUrl;
    }).toBe('https://files.iris.to');

    const createCalls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args.url).toBe('https://files.iris.to');

    const state = await getAutomationState(page);
    expect(state.currentView).toBe('webview');
    expect(state.canGoBack).toBe(true);
    expect(state.historyIndex).toBe(0);
  });

  test('home and reload commands reuse existing shell actions', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.waitForFunction(() => (window as any).__automationState?.shellReady === true);

    await emitTauriEvent(page, 'automation-command', {
      action: 'open_url',
      url: 'https://video.iris.to',
    });

    await expect.poll(async () => {
      const state = await getAutomationState(page);
      return state.currentView;
    }).toBe('webview');

    await emitTauriEvent(page, 'automation-command', { action: 'reload' });
    await expect.poll(async () => {
      const reloadCalls = await getInvocationsFor(page, 'reload_webview');
      return reloadCalls.length;
    }).toBe(1);

    await emitTauriEvent(page, 'automation-command', { action: 'home' });
    await expect.poll(async () => {
      const state = await getAutomationState(page);
      return state.currentView;
    }).toBe('launcher');

    const closeCalls = await getInvocationsFor(page, 'close_webview');
    expect(closeCalls.length).toBeGreaterThan(0);
  });
});
