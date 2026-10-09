import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist/extension',
    minify: false,
    cssMinify: false,
    target: 'firefox128',
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./src/extension/app.js', import.meta.url)),
        background: fileURLToPath(new URL('./src/extension/background.js', import.meta.url)),
      },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: '[name][extname]' },
    },
  },
});
