import { describe, expect, it } from 'vitest';
import { gitPortableBuild, portableAssetBase, sanitizePortableHtml } from '../portableViteConfig';

describe('git portable build config', () => {
  it('uses a relative asset base for git builds served from htree trees', () => {
    expect(portableAssetBase).toBe('./');
    expect(gitPortableBuild.outDir).toBe('iris-git');
    expect(gitPortableBuild.modulePreload).toBe(false);
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
