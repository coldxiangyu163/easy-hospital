import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**/*.ts', 'src/storage/**/*.ts', 'src/adapters/**/*.ts', 'src/server/app.ts'],
    },
  },
});
