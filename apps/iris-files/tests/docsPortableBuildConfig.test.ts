import { describe, expect, it } from 'vitest';
import { docsPortableBuild, portableAssetBase, sanitizePortableHtml } from '../portableViteConfig';

describe('docs portable build config', () => {
  it('uses a relative asset base for docs builds served from htree trees', () => {
    expect(portableAssetBase).toBe('./');
    expect(docsPortableBuild.outDir).toBe('dist-docs');
    expect(docsPortableBuild.modulePreload).toBe(false);
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
