/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

// Dev and preview bind to 127.0.0.1 only: the owner console is never served on a network interface.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5174, proxy: { '/api': apiTarget } },
  preview: { host: '127.0.0.1', port: 4174, proxy: { '/api': apiTarget } },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
