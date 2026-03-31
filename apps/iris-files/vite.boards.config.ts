import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { getAppBrand, getAppPwaIcons } from './src/lib/appBrand';
import {
  boardsManualChunks,
  boardsPortableBuild,
  portableAssetBase,
  portableAssetFileNames,
  rewritePortableEntryHtml,
  sanitizePortableHtml,
  type PortableFileOps,
} from './portableViteConfig';

const outDir = boardsPortableBuild.outDir;
const brand = getAppBrand('boards');

export const sanitizeBoardsHtml = sanitizePortableHtml;

export async function rewriteBoardsEntryHtml(
  buildDir: string,
  fileOps?: PortableFileOps,
): Promise<void> {
  await rewritePortableEntryHtml(buildDir, 'boards.html', fileOps);
}

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
        await rewriteBoardsEntryHtml(resolve(__dirname, outDir));
      } catch {
        // Ignore in dev mode.
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
    boardsEntryPlugin(),
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
        name: 'Iris Boards',
        short_name: 'Iris Boards',
        description: 'Collaborative kanban boards on Nostr',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: getAppPwaIcons('boards'),
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
    modulePreload: boardsPortableBuild.modulePreload,
    outDir,
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
        assetFileNames: portableAssetFileNames,
        manualChunks: boardsManualChunks,
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
