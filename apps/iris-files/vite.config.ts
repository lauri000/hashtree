import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { getAppBrand, getAppPwaIcons } from './src/lib/appBrand';
import {
  filesManualChunks,
  filesPortableBuild,
  getFilesBase,
  portableAssetFileNames,
  rewritePortableEntryHtml,
  sanitizePortableHtml,
} from './portableViteConfig';

const outDir = 'dist';
const brand = getAppBrand('files');

export const sanitizeFilesHtml = sanitizePortableHtml;

function filesPortableHtmlPlugin(): Plugin {
  return {
    name: 'files-portable-html',
    async closeBundle() {
      try {
        await rewritePortableEntryHtml(resolve(__dirname, outDir), 'index.html');
      } catch {
        // Ignore missing build output in dev mode.
      }
    },
  };
}

export default defineConfig({
  base: getFilesBase(),
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    UnoCSS(),
    svelte(),
    filesPortableHtmlPlugin(),
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
        name: 'Iris Files',
        short_name: 'Iris Files',
        description: 'Content-addressed file storage on Nostr',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        icons: getAppPwaIcons('files'),
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
        globIgnores: ['**/ffmpeg-core.*'], // FFmpeg is 32MB, don't precache
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB for wasm files
      },
    }),
    visualizer({
      open: false,
      gzipSize: true,
      filename: 'dist/stats.html',
    }),
    visualizer({
      open: false,
      gzipSize: true,
      filename: 'dist/stats-list.txt',
      template: 'list',
    }),
  ],
  root: resolve(__dirname),
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/lib'),
      'wasm-git': resolve(__dirname, 'public/lg2_async.js'),
      // Fix pnpm resolution for @noble/hashes subpath exports
      '@noble/hashes/hkdf.js': resolve(__dirname, '../../ts/node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/hkdf.js'),
      '@noble/hashes/sha2.js': resolve(__dirname, '../../ts/node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/sha2.js'),
    },
  },
  build: {
    modulePreload: filesPortableBuild.modulePreload,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      onLog(level, log, handler) {
        if (log.code === 'CIRCULAR_DEPENDENCY') return;
        const message = typeof log.message === 'string' ? log.message : '';
        if (message.includes('dynamic import will not move module into another chunk')) return;
        if (message.includes('Use of eval in') && message.includes('tseep')) return;
        handler(level, log);
      },
      output: {
        assetFileNames: portableAssetFileNames,
        manualChunks: filesManualChunks,
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: ['mayhem2.iris.to', 'mayhem1.iris.to', 'mayhem3.iris.to', 'mayhem4.iris.to'],
    hmr: {
      // Ensure HMR websocket connection is stable
      overlay: true,
    },
    headers: {
      // Cross-origin isolation headers for SharedArrayBuffer/FFmpeg
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      // CORP header needed for all resources in cross-origin isolated context
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  optimizeDeps: {
    exclude: ['wasm-git', '@ffmpeg/ffmpeg', '@ffmpeg/util'], // Don't pre-bundle wasm-git and ffmpeg, they have their own workers
  },
  assetsInclude: ['**/*.wasm'], // Treat wasm files as assets
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
