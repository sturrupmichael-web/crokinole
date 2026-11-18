import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Served from michaelsturrup.com/crokinole/. Override with VITE_BASE if needed.
//   /crokinole/        menu + local mode (pass-and-play, vs. computer)
//   /crokinole/host/   party-mode host screen (TV)
//   /crokinole/join/   party-mode phone controller
export default defineConfig({
  base: process.env.VITE_BASE ?? '/crokinole/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        host: resolve(__dirname, 'host/index.html'),
        join: resolve(__dirname, 'join/index.html'),
      },
    },
  },
  server: { host: true },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
