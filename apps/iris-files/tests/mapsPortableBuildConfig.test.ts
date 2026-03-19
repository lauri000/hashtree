import { describe, expect, it, vi } from 'vitest';

async function loadMapsConfig() {
  vi.resetModules();
  const configModule = await import('../vite.maps.config.ts');
  return configModule.default;
}

describe('maps portable build config', () => {
  it('uses a relative asset base for maps builds served from htree trees', async () => {
    const config = await loadMapsConfig();
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBe('dist-maps');
    expect(config.build?.modulePreload).toBe(false);
  });

  it('strips module preload and crossorigin hints for htree webviews', async () => {
    const configModule = await import('../vite.maps.config.ts');
    const sanitized = configModule.sanitizeMapsHtml(`
      <script type="module" crossorigin src="./assets/main.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/vendor.js">
      <link rel="stylesheet" crossorigin href="./assets/main.css">
    `);

    expect(sanitized).not.toContain('modulepreload');
    expect(sanitized).not.toContain('crossorigin');
    expect(sanitized).toContain('<script type="module" src="./assets/main.js"></script>');
    expect(sanitized).toContain('<link rel="stylesheet" href="./assets/main.css">');
  });
});
