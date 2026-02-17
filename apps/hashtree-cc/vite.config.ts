import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from 'unocss/vite';

export default defineConfig({
  plugins: [
    UnoCSS(),
    svelte(),
  ],
  build: {
    reportCompressedSize: true,
  },
  server: {
    port: 5176,
  },
});
