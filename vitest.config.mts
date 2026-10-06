import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so that Nest decorator metadata is emitted in tests.
const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        plugins,
        test: { name: 'unit', include: ['src/**/*.spec.ts'], environment: 'node' },
      },
      {
        plugins,
        test: {
          name: 'integration',
          include: ['test/**/*.spec.ts'],
          environment: 'node',
          // These share one Postgres and Redis (system device key, dictionaries, queues),
          // so files run one after another.
          fileParallelism: false,
        },
      },
    ],
  },
});
