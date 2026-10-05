import { fileURLToPath } from 'node:url';

/**
 * Which database the tests use. vitest.config.ts sets these variables from the vitest mode
 * (`vitest run --mode postgres`, the test:* npm scripts); `.env.test` holds only the connection
 * (`TEST_DATABASE_URL`).
 *
 * - `TEST_DB`: `pglite` (default) is an in-process PGlite, `postgres` a server at
 *   `TEST_DATABASE_URL`.
 * - `TEST_DB_RESET`: `fresh` (default) gives every test its own database copied from a migrated
 *   template; `truncate` shares one database per test file and empties it with a single TRUNCATE
 *   before each test.
 */
export type TestDbEngine = 'pglite' | 'postgres';
export type TestDbReset = 'fresh' | 'truncate';

const ENGINES: readonly TestDbEngine[] = ['pglite', 'postgres'];
const RESETS: readonly TestDbReset[] = ['fresh', 'truncate'];

export interface TestDbConfig {
  engine: TestDbEngine;
  reset: TestDbReset;
  /** Postgres only: a server URL whose user may CREATE DATABASE; its database is used for admin work. */
  postgresUrl: string;
}

export function readTestDbConfig(env: NodeJS.ProcessEnv = process.env): TestDbConfig {
  const engine = oneOf(env.TEST_DB ?? 'pglite', ENGINES, 'TEST_DB');
  const reset = oneOf(env.TEST_DB_RESET ?? 'fresh', RESETS, 'TEST_DB_RESET');
  const postgresUrl = env.TEST_DATABASE_URL ?? '';
  if (engine === 'postgres' && !postgresUrl) {
    throw new Error('TEST_DB=postgres needs TEST_DATABASE_URL (see .env.test.example)');
  }
  return { engine, reset, postgresUrl };
}

function oneOf<Value extends string>(
  value: string,
  allowed: readonly Value[],
  name: string,
): Value {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  }
  return match;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Every database the Postgres engine creates starts with this, so leftovers are easy to find. */
export const TEST_DATABASE_PREFIX = 'test_aw_';
export const TEMPLATE_DATABASE = `${TEST_DATABASE_PREFIX}template`;

/** The same server URL, pointing at another database. */
export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
