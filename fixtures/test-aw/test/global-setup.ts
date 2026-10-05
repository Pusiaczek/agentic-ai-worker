import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import {
  databaseUrl,
  MIGRATIONS_FOLDER,
  readTestDbConfig,
  TEMPLATE_DATABASE,
  TEST_DATABASE_PREFIX,
} from './helpers/test-db-config.js';

/**
 * With TEST_DB=postgres: migrates a template database once per run (tests clone it) and drops
 * every test database when the run ends. Leftovers of a crashed run are dropped first.
 */
export default async function setup() {
  const config = readTestDbConfig();
  if (config.engine !== 'postgres') return;

  const admin = new pg.Pool({ connectionString: config.postgresUrl, max: 1 });
  try {
    await admin.query('select 1');
  } catch (error) {
    await admin.end();
    throw new Error(
      `Cannot reach Postgres at ${withoutPassword(config.postgresUrl)} (${errorCode(error)}). ` +
        'Start it (see fixtures/README.md) or run the tests on PGlite (npm test).',
    );
  }
  await dropTestDatabases(admin);
  await admin.query(`create database "${TEMPLATE_DATABASE}"`);

  const template = new pg.Pool({
    connectionString: databaseUrl(config.postgresUrl, TEMPLATE_DATABASE),
    max: 1,
  });
  await migrate(drizzle(template), { migrationsFolder: MIGRATIONS_FOLDER });
  // CREATE DATABASE … TEMPLATE fails while anyone is connected to the template.
  await template.end();

  return async () => {
    await dropTestDatabases(admin);
    await admin.end();
  };
}

function withoutPassword(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.password) url.password = '***';
  return url.toString();
}

/** node-postgres reports a refused connection as an AggregateError with `code` and no message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error) return String(error.code);
  return error instanceof Error ? error.message : String(error);
}

async function dropTestDatabases(admin: pg.Pool) {
  const { rows } = await admin.query<{ datname: string }>(
    'select datname from pg_database where starts_with(datname, $1)',
    [TEST_DATABASE_PREFIX],
  );
  for (const { datname } of rows) {
    await admin.query(`drop database if exists "${datname}" with (force)`);
  }
}
