import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The webmail is served at the site root; /api is the Postarix API (same origin).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 3002,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false } },
  },
  build: { sourcemap: false, target: 'es2022' },
});
