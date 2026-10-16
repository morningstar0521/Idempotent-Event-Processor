import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['./tests/global-setup.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'chaos',
          include: ['tests/chaos/**/*.test.ts'],
          globalSetup: ['./tests/global-setup.ts']
        }
      }
    ]
  }
});

