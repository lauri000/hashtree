import { describe, expect, it } from 'vitest';
import { portableAssetBase, sanitizePortableHtml, videoPortableBuild } from '../portableViteConfig';

describe('video portable build config', () => {
  it('uses one relative-asset build for hosted video builds', () => {
    expect(portableAssetBase).toBe('./');
    expect(videoPortableBuild.outDir).toBe('dist-video');
  });

  it('keeps the same output directory and asset base for Iris-delivered video builds', () => {
    expect(portableAssetBase).toBe('./');
    expect(videoPortableBuild.outDir).toBe('dist-video');
  });

  it('strips module preload and crossorigin hints for htree webviews', () => {
    const sanitized = sanitizePortableHtml(`
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
