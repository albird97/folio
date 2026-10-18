import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: [
            'packages/{document-model,pdf-core,platform-adapters}/src/**/*.test.ts',
            'packages/editor/src/**/*.node.test.ts',
            'apps/*/src/**/*.node.test.ts',
            'scripts/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: [
            'packages/{shared-ui,editor}/src/**/*.test.{ts,tsx}',
            'apps/*/src/**/*.dom.test.{ts,tsx}',
          ],
          exclude: ['**/*.node.test.ts', '**/node_modules/**'],
          setupFiles: ['./tests/setup/dom.ts'],
        },
      },
    ],
  },
});
