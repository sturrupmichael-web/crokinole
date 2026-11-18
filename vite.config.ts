import { defineConfig } from 'vite';

// Served from michaelsturrup.com/crokinole/. Override with VITE_BASE if needed.
// Milestone 1 is the engine only; the host/phone/local pages are added in later milestones.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/crokinole/',
  server: { host: true },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
