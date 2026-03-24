import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Exclude modules that require Electron runtime
    exclude: ['node_modules', 'dist'],
  },
});
