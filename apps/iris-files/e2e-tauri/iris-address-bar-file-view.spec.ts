/**
 * Tauri E2E test for Iris address bar file navigation
 *
 * Verifies npub paths open file views without detouring to profile
 * and that HTML/image viewers persist.
 */
import { browser, $ } from '@wdio/globals';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'e2e-tauri/screenshots');
const TEST_NPUB = 'npub1wj6a4ex6hsp7rq4g3h9fzqwezt9f0478vnku9wzzkl25w2uudnds4z3upt';

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function takeScreenshot(name: string): Promise<string> {
  const screenshot = await browser.takeScreenshot();
  const filepath = path.join(SCREENSHOTS_DIR, `${name}-${Date.now()}.png`);
  fs.writeFileSync(filepath, screenshot, 'base64');
  return filepath;
}

async function submitAddress(value: string): Promise<void> {
  const addressInput = await $('input[placeholder="Search or enter address"]');
  await addressInput.waitForExist({ timeout: 30000 });
  await addressInput.click();
  await addressInput.clearValue();
  await addressInput.setValue(value);
  await browser.keys(['Enter']);
}

describe('Iris address bar file navigation', () => {
  it('loads index.html from npub path without falling back to profile', async () => {
    const htmlPath = `${TEST_NPUB}/public/jumble/dist/index.html`;

    await browser.url('tauri://localhost/#/');
    await submitAddress(htmlPath);

    await browser.waitUntil(async () => {
      const hash = await browser.execute(() => window.location.hash);
      return hash === `#/${htmlPath}`;
    }, {
      timeout: 15000,
      timeoutMsg: 'Expected address bar navigation to land on the HTML file route',
    });

    const fileList = await $('[data-testid="file-list"]');
    await fileList.waitForExist({ timeout: 5000 });

    const htmlIframe = await $('iframe[title="index.html"]');
    await htmlIframe.waitForExist({ timeout: 60000 });
    await browser.waitUntil(async () => {
      return htmlIframe.isDisplayed();
    }, {
      timeout: 10000,
      timeoutMsg: 'Expected HTML viewer iframe to be displayed',
    });

    const htmlBase = await browser.execute(() => {
      const el = document.querySelector('[data-testid="html-viewer"]') as HTMLElement | null;
      return el?.getAttribute('data-htree-base') || '';
    });
    expect(htmlBase.startsWith('http://127.0.0.1:21417/htree/')).toBe(true);

    await browser.pause(1500);
    expect(await htmlIframe.isDisplayed()).toBe(true);

    const screenshotPath = await takeScreenshot('iris-html-index');
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });

  it('keeps pwa-512x512.png visible after address bar navigation', async () => {
    const imagePath = `${TEST_NPUB}/public/jumble/dist/pwa-512x512.png`;

    await browser.url('tauri://localhost/#/');
    await submitAddress(imagePath);

    await browser.waitUntil(async () => {
      const hash = await browser.execute(() => window.location.hash);
      return hash === `#/${imagePath}`;
    }, {
      timeout: 15000,
      timeoutMsg: 'Expected address bar navigation to land on the PNG file route',
    });

    const image = await $('[data-testid="image-viewer"]');
    await image.waitForExist({ timeout: 60000 });

    await browser.waitUntil(async () => {
      const state = await browser.execute(() => {
        const img = document.querySelector('[data-testid="image-viewer"]') as HTMLImageElement | null;
        if (!img) return { ready: false, width: 0, height: 0, visible: false };
        const style = window.getComputedStyle(img);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        return {
          ready: img.complete,
          width: img.naturalWidth,
          height: img.naturalHeight,
          visible,
        };
      });
      return state.ready && state.visible && state.width >= 512 && state.height >= 512;
    }, {
      timeout: 60000,
      interval: 500,
      timeoutMsg: 'Expected PNG to load and be visible',
    });

    await browser.pause(1500);
    expect(await image.isDisplayed()).toBe(true);

    const screenshotPath = await takeScreenshot('iris-image-pwa-512');
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });
});
