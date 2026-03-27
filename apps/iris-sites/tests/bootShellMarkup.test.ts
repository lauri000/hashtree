import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src', 'App.svelte'), 'utf8');

describe('boot shell markup', () => {
  it('keeps the shell blank initially instead of flashing the site title while booting', () => {
    expect(appSource).toContain('const BOOT_STATUS_DELAY_MS = 2500;');
    expect(appSource).toContain('let showBootStatus = $state(false);');
    expect(appSource).not.toContain('<h1>{currentSite.title}</h1>');
    expect(appSource).toContain('This site is taking longer than usual to start.');
  });

  it('uses concise launcher copy instead of long example URLs in the hero text', () => {
    expect(appSource).toContain('<h1>Open hashtree sites on their own origin.</h1>');
    expect(appSource).toContain('Paste an <code>nhash</code>, <code>npub/tree</code>, or share URL below.');
    expect(appSource).not.toContain('Use a hash route like <code>https://sites.iris.to/#/nhash.../index.html</code>');
  });

  it('waits for the iframe to finish loading before revealing it', () => {
    expect(appSource).toContain('let iframeLoaded = $state(false);');
    expect(appSource).toContain('onload={handleFrameLoad}');
    expect(appSource).toContain('class:site-frame-ready={iframeLoaded}');
    expect(appSource).toContain('opacity: 0;');
  });
});
