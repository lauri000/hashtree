import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { rename } from 'fs/promises';

function boardsEntryPlugin(): Plugin {
  return {
    name: 'boards-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') {
          req.url = '/boards.html';
        }
        next();
      });
    },
    async closeBundle() {
      try {
        await rename(
          resolve(__dirname, 'dist-boards/boards.html'),
          resolve(__dirname, 'dist-boards/index.html')
        );
      } catch {
        // Ignore in dev mode.
      }
    },
  };
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    boardsEntryPlugin(),
    UnoCSS(),
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['iris-favicon.png', 'apple-touch-icon.png'],
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'Iris Boards',
        short_name: 'Iris Boards',
        description: 'Collaborative kanban boards on Nostr',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: [
          {
            src: 'iris-logo.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'iris-logo.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'iris-logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
        globIgnores: ['**/ffmpeg-core.*'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  root: resolve(__dirname),
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/lib'),
      'wasm-git': resolve(__dirname, 'public/lg2_async.js'),
    },
  },
  build: {
    outDir: 'dist-boards',
    emptyOutDir: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'boards.html'),
      },
      onLog(level, log, handler) {
        if (log.code === 'CIRCULAR_DEPENDENCY') return;
        const message = typeof log.message === 'string' ? log.message : '';
        if (message.includes('dynamic import will not move module into another chunk')) return;
        if (message.includes('Use of eval in') && message.includes('tseep')) return;
        if (message.includes('has been externalized for browser compatibility')) return;
        handler(level, log);
      },
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
        manualChunks: (id) => {
          if (id.includes('marked')) {
            return 'markdown';
          }
          if (id.includes('coco-cashu') || id.includes('cashu-ts')) {
            return 'wallet';
          }
          if (id.includes('@nostr-dev-kit/ndk')) {
            return 'ndk';
          }
          if (id.includes('dexie')) {
            return 'dexie';
          }
          const vendorLibs = [
            'svelte',
            'nostr-tools',
            '@noble/hashes',
            '@noble/curves',
            '@scure/base',
            'idb-keyval',
          ];
          if (vendorLibs.some((lib) => id.includes(`node_modules/${lib}`))) {
            return 'vendor';
          }
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['mayhem2.iris.to', 'mayhem1.iris.to', 'mayhem3.iris.to', 'mayhem4.iris.to'],
    hmr: {
      overlay: true,
    },
  },
  optimizeDeps: {
    exclude: ['wasm-git'],
  },
  assetsInclude: ['**/*.wasm'],
});
