import { defineConfig } from 'vite';

// Em desenvolvimento (npm run dev:launcher), o Vite repassa para o daemon
// tudo o que não é do launcher: WebSocket, API e arquivos do cartucho.
const daemon = `http://127.0.0.1:${process.env.PLAYZIN_PORT ?? 7777}`;

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000, // o Phaser é grande e tudo bem: roda local, sem download
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: daemon, ws: true },
      '/api': daemon,
      '/cart': daemon,
    },
  },
});
