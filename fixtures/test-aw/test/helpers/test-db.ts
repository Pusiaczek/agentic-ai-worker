import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import type { Db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import {
  databaseUrl,
  MIGRATIONS_FOLDER,
  readTestDbConfig,
  TEMPLATE_DATABASE,
  TEST_DATABASE_PREFIX,
} from './test-db-config.js';

/** The raw connection a test can use next to Drizzle: PGlite itself, or a node-postgres pool. */
export interface TestClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface TestDatabase {
  db: Db;
  client: TestClient;
  /** Closes (and on Postgres drops) a database the test owns; a shared one stays open. */
  release(): Promise<void>;
}

/** A database shared by the tests of one file (`TEST_DB_RESET=truncate`). */
interface SharedDatabase {
  db: Db;
  client: TestClient;
  /** One TRUNCATE of every table in `public`; Drizzle keeps its migrations table in `drizzle`. */
  truncateAll: string;
}

const config = readTestDbConfig();

/**
 * A clean, migrated database for one test, as chosen by the vitest mode (see test-db-config.ts).
 * `ownDatabase` gives the test a database of its own even with `TEST_DB_RESET=truncate`: needed by
 * tests that close the connection or change the schema.
 */
export function openTestDatabase({ ownDatabase = false } = {}): Promise<TestDatabase> {
  const shared = config.reset === 'truncate' && !ownDatabase;
  if (config.engine === 'pglite') return shared ? useShared(openSharedPglite) : freshPglite();
  return shared ? useShared(openSharedPostgres) : freshPostgres();
}

/** Closes the file's shared database and admin connection; test/setup.ts runs it after each file. */
export async function closeSharedDatabase() {
  const database = await sharedDatabase;
  sharedDatabase = undefined;
  if (database && !database.client.closed) await database.client.close();
  await adminPool?.end();
  adminPool = undefined;
}

// Shared database (TEST_DB_RESET=truncate). Vitest evaluates this module again for every test
// file, so "shared" means shared by the tests of one file.

let sharedDatabase: Promise<SharedDatabase> | undefined;

async function useShared(open: () => Promise<SharedDatabase>): Promise<TestDatabase> {
  sharedDatabase ??= open();
  const database = await sharedDatabase;
  if (database.truncateAll) await database.client.exec(database.truncateAll);
  return { db: database.db, client: database.client, release: async () => {} };
}

async function truncateAllStatement(client: TestClient): Promise<string> {
  const { rows } = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  if (rows.length === 0) return '';
  return `truncate ${rows.map((row) => `"${row.tablename}"`).join(', ')} restart identity`;
}

// PGlite: a migrated template is built once per test file and dumped; every database is a copy.

let pgliteTemplate: Promise<File | Blob> | undefined;

function pgliteTemplateDataDir(): Promise<File | Blob> {
  pgliteTemplate ??= (async () => {
    const client = new PGlite();
    // drizzle/ exists once the first migration has been generated (npm run db:generate).
    if (existsSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))) {
      await migratePglite(drizzlePglite(client, { schema }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    }
    const dataDir = await client.dumpDataDir('none');
    await client.close();
    return dataDir;
  })();
  return pgliteTemplate;
}

async function freshPglite(): Promise<TestDatabase> {
  const client = new PGlite({ loadDataDir: await pgliteTemplateDataDir() });
  return {
    db: drizzlePglite(client, { schema }),
    client,
    release: async () => {
      if (!client.closed) await client.close();
    },
  };
}

async function openSharedPglite(): Promise<SharedDatabase> {
  const client = new PGlite({ loadDataDir: await pgliteTemplateDataDir() });
  return {
    db: drizzlePglite(client, { schema }),
    client,
    truncateAll: await truncateAllStatement(client),
  };
}

// Postgres: test/global-setup.ts creates the migrated template database once per run; databases
// are cloned from it with CREATE DATABASE … TEMPLATE and named after the vitest worker.

/** VITEST_POOL_ID numbers the workers 1…maxWorkers; files running at the same time never share one. */
const workerId = process.env.VITEST_POOL_ID ?? '0';
let adminPool: pg.Pool | undefined;
let testDatabaseCount = 0;

/** One connection to the server's admin database per test file, for CREATE and DROP DATABASE. */
function admin(): pg.Pool {
  adminPool ??= new pg.Pool({ connectionString: config.postgresUrl, max: 1 });
  return adminPool;
}

async function cloneTemplate(name: string) {
  await admin().query(`drop database if exists "${name}" with (force)`);
  await admin().query(`create database "${name}" template "${TEMPLATE_DATABASE}"`);
}

function connectPostgres(name: string): { db: Db; client: TestClient } {
  const pool = new pg.Pool({ connectionString: databaseUrl(config.postgresUrl, name), max: 2 });
  const client: TestClient = {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
    get closed() {
      return pool.ended;
    },
  };
  return { db: drizzleNodePostgres(pool, { schema }), client };
}

async function freshPostgres(): Promise<TestDatabase> {
  testDatabaseCount += 1;
  const name = `${TEST_DATABASE_PREFIX}w${workerId}_t${testDatabaseCount}`;
  await cloneTemplate(name);
  const { db, client } = connectPostgres(name);
  return {
    db,
    client,
    release: async () => {
      if (!client.closed) await client.close();
      await admin().query(`drop database if exists "${name}" with (force)`);
    },
  };
}

async function openSharedPostgres(): Promise<SharedDatabase> {
  const name = `${TEST_DATABASE_PREFIX}w${workerId}`;
  await cloneTemplate(name);
  const { db, client } = connectPostgres(name);
  return { db, client, truncateAll: await truncateAllStatement(client) };
}
