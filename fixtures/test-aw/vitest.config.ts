import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';
import type { TestDbEngine, TestDbReset } from './test/helpers/test-db-config.js';

/**
 * The test database for each vitest mode (`vitest run --mode <mode>`, see the test:* npm scripts);
 * `test` is vitest's default mode. The choice reaches the tests as TEST_DB and TEST_DB_RESET.
 */
const TEST_DATABASE_BY_MODE: Record<string, { engine: TestDbEngine; reset: TestDbReset }> = {
  test: { engine: 'pglite', reset: 'fresh' },
  pglite: { engine: 'pglite', reset: 'fresh' },
  'pglite-truncate': { engine: 'pglite', reset: 'truncate' },
  postgres: { engine: 'postgres', reset: 'fresh' },
  'postgres-truncate': { engine: 'postgres', reset: 'truncate' },
};

// .env.test holds only the Postgres connection; nothing else is read from it.
const envTestFile = new URL('.env.test', import.meta.url);
if (existsSync(envTestFile)) {
  const { TEST_DATABASE_URL } = parseEnv(readFileSync(envTestFile, 'utf8'));
  process.env.TEST_DATABASE_URL ??= TEST_DATABASE_URL;
}

export default defineConfig(({ mode }) => {
  const database = TEST_DATABASE_BY_MODE[mode];
  if (!database) {
    const modes = Object.keys(TEST_DATABASE_BY_MODE).join(', ');
    throw new Error(`Unknown vitest mode "${mode}". Test database modes: ${modes}`);
  }
  process.env.TEST_DB = database.engine;
  process.env.TEST_DB_RESET = database.reset;

  return {
    test: {
      include: ['test/**/*.test.ts'],
      globalSetup: ['test/global-setup.ts'],
      setupFiles: ['test/setup.ts'],
    },
  };
});
