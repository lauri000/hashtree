import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

async function loadBoardsConfig() {
  vi.resetModules();
  const configModule = await import('../vite.boards.config.ts');
  return configModule.default;
}

describe('boards portable build config', () => {
  it('uses a relative asset base for boards builds served from htree trees', async () => {
    const config = await loadBoardsConfig();
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBe('dist-boards');
    expect(config.build?.modulePreload).toBe(false);
  });

  it('strips module preload and crossorigin hints for htree webviews', async () => {
    const configModule = await import('../vite.boards.config.ts');
    const sanitized = configModule.sanitizeBoardsHtml(`
      <script type="module" crossorigin src="./assets/main.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/vendor.js">
      <link rel="stylesheet" crossorigin href="./assets/main.css">
    `);

    expect(sanitized).not.toContain('modulepreload');
    expect(sanitized).not.toContain('crossorigin');
    expect(sanitized).toContain('<script type="module" src="./assets/main.js"></script>');
    expect(sanitized).toContain('<link rel="stylesheet" href="./assets/main.css">');
  });

  it('rewrites boards.html into sanitized index.html for htree publishing', async () => {
    const configModule = await import('../vite.boards.config.ts');
    const buildDir = await mkdtemp(join(tmpdir(), 'boards-portable-build-'));
    const sourcePath = join(buildDir, 'boards.html');
    const targetPath = join(buildDir, 'index.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<script type="module" crossorigin src="./assets/main.js"></script>',
        '<link rel="modulepreload" crossorigin href="./assets/vendor.js">',
        '<link rel="stylesheet" crossorigin href="./assets/main.css">',
      ].join('\n'),
      'utf8',
    );

    await configModule.rewriteBoardsEntryHtml(buildDir);

    const rewritten = await readFile(targetPath, 'utf8');
    expect(rewritten).toContain('<script type="module" src="./assets/main.js"></script>');
    expect(rewritten).toContain('<link rel="stylesheet" href="./assets/main.css">');
    expect(rewritten).not.toContain('modulepreload');
    expect(rewritten).not.toContain('crossorigin');
  });
});
