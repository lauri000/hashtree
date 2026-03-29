import { describe, expect, it, vi } from 'vitest';

async function loadFilesConfig() {
  vi.resetModules();
  const configModule = await import('../vite.config.ts');
  return configModule.default;
}

describe('files portable build config', () => {
  it('uses a relative asset base for files builds served from htree trees', async () => {
    const config = await loadFilesConfig();
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBeUndefined();
    expect(config.build?.modulePreload).toBe(false);
  });

  it('does not split a removed executable-emulation chunk', async () => {
    const config = await loadFilesConfig();
    const manualChunks = config.build?.rollupOptions?.output;
    const chunker = Array.isArray(manualChunks) ? manualChunks[0]?.manualChunks : manualChunks?.manualChunks;

    expect(typeof chunker).toBe('function');
    expect(chunker?.('/workspace/node_modules/emulators/dist/index.js')).toBeUndefined();
    expect(chunker?.('/workspace/node_modules/js-dos/index.js')).toBeUndefined();
    expect(chunker?.('/workspace/node_modules/marked/lib/marked.js')).toBe('markdown');
  });

  it('strips module preload and crossorigin hints for htree webviews', async () => {
    const configModule = await import('../vite.config.ts');
    const sanitized = configModule.sanitizeFilesHtml(`
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
