import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { getAppBrand, type IrisFilesAppId } from '../src/lib/appBrand';

const root = process.cwd();
const publicDir = path.join(root, 'public');

const APPS = ['files', 'docs', 'video', 'git', 'maps', 'boards'] as const satisfies readonly IrisFilesAppId[];

const htmlEntries: Record<IrisFilesAppId, string> = {
  files: 'index.html',
  docs: 'docs.html',
  video: 'video.html',
  git: 'git.html',
  maps: 'maps.html',
  boards: 'boards.html',
};

const configEntries: Record<IrisFilesAppId, string> = {
  files: 'vite.config.ts',
  docs: 'vite.docs.config.ts',
  video: 'vite.video.config.ts',
  git: 'vite.git.config.ts',
  maps: 'vite.maps.config.ts',
  boards: 'vite.boards.config.ts',
};

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('iris-files app branding', () => {
  it('defines a distinct icon set for each app shell', () => {
    const iconAssets = APPS.map((app) => getAppBrand(app).iconSvg);
    const pwaAssets = APPS.map((app) => getAppBrand(app).pwa192Png);

    expect(new Set(iconAssets).size).toBe(APPS.length);
    expect(new Set(pwaAssets).size).toBe(APPS.length);

    for (const app of APPS) {
      const brand = getAppBrand(app);
      expect(fs.existsSync(path.join(publicDir, brand.iconSvg))).toBe(true);
      expect(fs.existsSync(path.join(publicDir, brand.appleTouchPng))).toBe(true);
      expect(fs.existsSync(path.join(publicDir, brand.pwa192Png))).toBe(true);
      expect(fs.existsSync(path.join(publicDir, brand.pwa512Png))).toBe(true);
    }
  });

  it('points each html entry to its own favicon svg', () => {
    for (const app of APPS) {
      const source = read(htmlEntries[app]);
      const brand = getAppBrand(app);

      expect(source).toContain(`type="image/svg+xml" href="%BASE_URL%${brand.iconSvg}"`);
      expect(source).not.toContain('iris-favicon.png');
    }
  });

  it('uses per-app install icons in each portable build config', () => {
    for (const app of APPS) {
      const source = read(configEntries[app]);

      expect(source).toContain(`const brand = getAppBrand('${app}')`);
      expect(source).toContain('includeAssets: [brand.iconSvg, brand.appleTouchPng]');
      expect(source).toContain(`icons: getAppPwaIcons('${app}')`);
      expect(source).not.toContain("'iris-logo.png'");
    }
  });
});
