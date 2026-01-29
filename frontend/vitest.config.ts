import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  cacheDir: '.vite',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
