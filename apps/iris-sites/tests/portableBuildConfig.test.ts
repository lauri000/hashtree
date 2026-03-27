import { describe, expect, it } from 'vitest';

async function loadConfig() {
  const configModule = await import('../vite.config');
  return configModule.default;
}

describe('iris-sites build config', () => {
  it('uses a relative asset base for isolated hosts and boot iframes', async () => {
    const config = await loadConfig();
    expect(config.base).toBe('./');
    expect(config.build?.modulePreload).toBe(false);
  });

  it('strips module preload and crossorigin hints from portable HTML output', async () => {
    const configModule = await import('../vite.config');
    const sanitized = configModule.sanitizePortableHtml(`
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
