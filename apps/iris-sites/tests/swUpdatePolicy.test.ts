import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const swInitSource = fs.readFileSync(path.resolve(process.cwd(), 'src', 'lib', 'swInit.ts'), 'utf8');
const viteConfigSource = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');

describe('service worker update policy', () => {
  it('activates waiting updates immediately on runtime hosts', () => {
    expect(viteConfigSource).toContain("registerType: 'autoUpdate'");
    expect(swInitSource).toContain('onNeedRefresh()');
    expect(swInitSource).toContain('updateSW(true);');
  });

  it('reloads once when a new worker takes control so fresh assets are used', () => {
    expect(swInitSource).toContain("navigator.serviceWorker.addEventListener('controllerchange'");
    expect(swInitSource).toContain("const reloadKey = 'iris-sites-sw-reload';");
    expect(swInitSource).toContain('window.location.reload();');
  });
});
