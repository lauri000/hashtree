import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function sanitizePortableHtml(html: string): string {
  return html
    .replace(/^\s*<link rel="modulepreload".*$/gm, '')
    .replace(/\s+crossorigin(?=[\s>])/g, '');
}

function portableHtmlPlugin(): Plugin {
  return {
    name: 'portable-html',
    async closeBundle() {
      const indexPath = resolve(__dirname, 'dist', 'index.html');
      try {
        const html = await readFile(indexPath, 'utf8');
        await writeFile(indexPath, sanitizePortableHtml(html), 'utf8');
      } catch {
        // Ignore when build output does not exist.
      }
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.npm_package_version || '0.1.0'),
  },
  plugins: [
    portableHtmlPlugin(),
    UnoCSS(),
    svelte(),
    VitePWA({
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['favicon.svg'],
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'hashtree.cc',
        short_name: 'hashtree.cc',
        description: 'Decentralized file sharing with hashtree',
        theme_color: '#916dfe',
        background_color: '#f5f5f5',
        display: 'standalone',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  build: {
    modulePreload: false,
    reportCompressedSize: true,
  },
  server: {
    port: 5176,
  },
});
