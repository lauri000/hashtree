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
  it('uses root-relative assets for hosted video builds', async () => {
    const config = await loadVideoConfig();
    expect(config.base ?? '/').toBe('/');
    expect(config.build?.outDir).toBe('dist-video');
  });

  it('uses relative assets for portable Iris video builds', async () => {
    const config = await loadVideoConfig('true');
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBe('dist-video-iris');
  });
});
