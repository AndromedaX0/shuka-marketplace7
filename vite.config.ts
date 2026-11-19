import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const clientRoot = fileURLToPath(new URL('./client/', import.meta.url));
const apiPort = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);
const vitePort = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: vitePort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      '/uploads': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});