import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPortable = process.env.HTREE_PORTABLE_BUILD;

async function loadVideoConfig(portable?: string) {
  if (portable === undefined) {
    delete process.env.HTREE_PORTABLE_BUILD;
  } else {
    process.env.HTREE_PORTABLE_BUILD = portable;
  }

  vi.resetModules();
  const configModule = await import('../vite.video.config.ts');
  return configModule.default;
}

afterEach(() => {
  if (originalPortable === undefined) {
    delete process.env.HTREE_PORTABLE_BUILD;
  } else {
    process.env.HTREE_PORTABLE_BUILD = originalPortable;
  }
});

describe('video portable build config', () => {
  it('uses one relative-asset build for hosted video builds', async () => {
    const config = await loadVideoConfig();
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBe('dist-video');
  });

  it('keeps the same output directory and asset base for Iris-delivered video builds', async () => {
    const config = await loadVideoConfig('true');
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBe('dist-video');
  });

  it('strips module preload and crossorigin hints for htree webviews', async () => {
    const configModule = await import('../vite.video.config.ts');
    const sanitized = configModule.sanitizeVideoHtml(`
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
