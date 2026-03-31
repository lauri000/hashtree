import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { getAppBrand, getAppPwaIcons } from './src/lib/appBrand';
import {
  portableAssetBase,
  portableAssetFileNames,
  rewritePortableEntryHtml,
  sanitizePortableHtml,
  videoManualChunks,
  videoPortableBuild,
} from './portableViteConfig';

const outDir = videoPortableBuild.outDir;
const brand = getAppBrand('video');

export const sanitizeVideoHtml = sanitizePortableHtml;

function videoEntryPlugin(): Plugin {
  return {
    name: 'video-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') {
          req.url = '/video.html';
        }
        next();
      });
    },
    async closeBundle() {
      // Rename video.html to index.html and remove custom-scheme-hostile
      // preload/crossorigin hints that blank the app inside htree:// webviews.
      try {
        await rewritePortableEntryHtml(resolve(__dirname, outDir), 'video.html');
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
    videoEntryPlugin(),
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
        name: 'Iris Video',
        short_name: 'Iris Video',
        description: 'Decentralized video sharing on Nostr',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: getAppPwaIcons('video'),
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
        // Exclude ffmpeg-core.wasm (~32MB) - loaded on-demand, not precached
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
    modulePreload: videoPortableBuild.modulePreload,
    outDir,
    emptyOutDir: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'video.html'),
      },
      external: [
        '@tauri-apps/plugin-autostart',
        '@tauri-apps/plugin-dialog',
        '@tauri-apps/plugin-notification',
        '@tauri-apps/plugin-opener',
        '@tauri-apps/plugin-os',
        '@tauri-apps/api',
      ],
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
        manualChunks: videoManualChunks,
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
    exclude: ['wasm-git', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  assetsInclude: ['**/*.wasm'],
});
