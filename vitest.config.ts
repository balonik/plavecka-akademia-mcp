import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Only the parsing/logic core is held to a coverage bar: `src/functions/**` is a
      // thin Azure Functions HTTP adapter and `src/server.ts` is wiring, neither of which
      // is meaningfully unit-testable (or worth gating CI on) without a real HTTP host.
      include: ['src/site/**', 'src/tools/**'],
      exclude: ['src/functions/**', 'src/server.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
