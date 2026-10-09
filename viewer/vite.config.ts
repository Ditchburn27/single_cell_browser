import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  server: { fs: { allow: ['..'] } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 120000 },
});
