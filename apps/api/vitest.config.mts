import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the tests so NestJS decorator metadata (used for dependency injection) is emitted.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts'],
  },
});
