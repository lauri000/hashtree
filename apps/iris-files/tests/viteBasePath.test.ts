import { afterEach, describe, expect, it, vi } from 'vitest';
const originalGithubPages = process.env.GITHUB_PAGES;

async function loadViteConfig(githubPages?: string) {
  if (githubPages === undefined) {
    delete process.env.GITHUB_PAGES;
  } else {
    process.env.GITHUB_PAGES = githubPages;
  }

  vi.resetModules();
  const configModule = await import('../vite.config.ts');
  return configModule.default;
}

afterEach(() => {
  if (originalGithubPages === undefined) {
    delete process.env.GITHUB_PAGES;
  } else {
    process.env.GITHUB_PAGES = originalGithubPages;
  }
});

describe('vite base path', () => {
  it('uses /hashtree/ for GitHub Pages builds', async () => {
    const config = await loadViteConfig('true');
    expect(config.base).toBe('/hashtree/');
  });

  it('uses / outside GitHub Pages builds', async () => {
    const config = await loadViteConfig();
    expect(config.base ?? '/').toBe('/');
  });
});
