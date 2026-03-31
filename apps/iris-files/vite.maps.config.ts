import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { getAppBrand, getAppPwaIcons } from './src/lib/appBrand';
import {
  mapsManualChunks,
  mapsPortableBuild,
  portableAssetBase,
  portableAssetFileNames,
  rewritePortableEntryHtml,
  sanitizePortableHtml,
} from './portableViteConfig';

const outDir = mapsPortableBuild.outDir;
const brand = getAppBrand('maps');

export const sanitizeMapsHtml = sanitizePortableHtml;

function mapsEntryPlugin(): Plugin {
  return {
    name: 'maps-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') {
          req.url = '/maps.html';
        }
        next();
      });
    },
    async closeBundle() {
      // Rename maps.html to index.html and strip hints that break htree:// delivery.
      try {
        await rewritePortableEntryHtml(resolve(__dirname, outDir), 'maps.html');
      } catch {
        // Ignore if file doesn't exist (dev mode)
      }
    },
  };
}

export default defineConfig({
  base: portableAssetBase,
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    mapsEntryPlugin(),
    UnoCSS(),
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: [brand.iconSvg, brand.appleTouchPng],
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'Iris Maps',
        short_name: 'Iris Maps',
        description: 'Offline-first maps on Nostr',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: getAppPwaIcons('maps'),
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
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
    modulePreload: mapsPortableBuild.modulePreload,
    outDir,
    emptyOutDir: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'maps.html'),
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
        assetFileNames: portableAssetFileNames,
        manualChunks: mapsManualChunks,
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
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  optimizeDeps: {
    exclude: ['wasm-git', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
