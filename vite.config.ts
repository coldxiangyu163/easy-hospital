import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 3211,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3210',
    },
  },
});
