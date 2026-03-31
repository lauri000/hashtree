import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { getAppBrand, getAppPwaIcons } from './src/lib/appBrand';
import {
  gitManualChunks,
  gitPortableBuild,
  portableAssetBase,
  portableAssetFileNames,
  rewritePortableEntryHtml,
  sanitizePortableHtml,
} from './portableViteConfig';

const outDir = gitPortableBuild.outDir;
const brand = getAppBrand('git');

export const sanitizeGitHtml = sanitizePortableHtml;

function gitEntryPlugin(): Plugin {
  return {
    name: 'git-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') {
          req.url = '/git.html';
        }
        next();
      });
    },
    async closeBundle() {
      try {
        await rewritePortableEntryHtml(resolve(__dirname, outDir), 'git.html');
      } catch {
        // Ignore missing build output in dev mode.
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
    gitEntryPlugin(),
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
        name: 'Iris Git',
        short_name: 'Iris Git',
        description: 'Git repositories on Nostr',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: getAppPwaIcons('git'),
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
    modulePreload: gitPortableBuild.modulePreload,
    outDir,
    emptyOutDir: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'git.html'),
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
        manualChunks: gitManualChunks,
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
