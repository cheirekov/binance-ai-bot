import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  cacheDir: '.vite',
  plugins: [react()],
  server: {
    port: 4173,
  },
});
