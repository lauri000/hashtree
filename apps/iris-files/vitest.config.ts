import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/lib'),
      'virtual:uno.css': resolve(__dirname, 'tests/stubs/emptyVirtualModule.ts'),
      'wasm-git': resolve(__dirname, 'public/lg2_async.js'),
      '@noble/hashes/hkdf.js': resolve(__dirname, '../../ts/node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/hkdf.js'),
      '@noble/hashes/sha2.js': resolve(__dirname, '../../ts/node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/sha2.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
