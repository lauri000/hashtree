import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
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
  plugins: [
    portableHtmlPlugin(),
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'iris sites',
        short_name: 'iris sites',
        description: 'Isolated hashtree sites on the web',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
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
    rollupOptions: {
      onLog(level, log, handler) {
        const message = typeof log.message === 'string' ? log.message : '';
        if (message.includes('Use of eval in') && message.includes('tseep')) return;
        handler(level, log);
      },
    },
  },
  server: {
    port: 5178,
    allowedHosts: [
      'sites.iris.to',
      '.sites.iris.to',
      '.hashtree.cc',
      'sites.iris.localhost',
      '.sites.iris.localhost',
    ],
  },
});
