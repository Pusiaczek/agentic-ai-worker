import { buildApp } from '../../src/app.js';
import { openTestDatabase } from './test-db.js';

/**
 * The app wired to a clean, migrated database: in-process PGlite or a Postgres server, as chosen
 * by the vitest mode (see test/helpers/test-db-config.ts). Call `app.close()` when done;
 * it also releases the database. `ownDatabase` is for tests that close the connection or change
 * the schema: they get a database no other test uses.
 */
export async function buildTestApp({ ownDatabase = false } = {}) {
  const { db, client, release } = await openTestDatabase({ ownDatabase });

  const app = buildApp({ db });
  app.addHook('onClose', release);

  return { app, db, client };
}

export type TestContext = Awaited<ReturnType<typeof buildTestApp>>;
