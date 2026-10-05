import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { buildTestApp, type TestContext } from '../helpers/app.js';
import { insertUser, insertUsers } from '../helpers/users.js';

const INDEX_NAME = 'users_email_active_unique';
const LONG_AGO = new Date('2024-01-01T00:00:00.000Z');

/** Runs a query that is expected to fail and returns the Postgres error (unwrapped from Drizzle). */
async function pgErrorOf(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (err) {
    return (err as { cause?: unknown }).cause ?? err;
  }
  throw new Error('expected the query to fail, but it succeeded');
}

describe('users table (migrations in drizzle/)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('has the contract columns: uuid id, email, name varchar(100), timestamps, nullable deleted_at', async () => {
    const { rows } = await ctx.client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      character_maximum_length: number | string | null;
      column_default: string | null;
    }>(
      `select column_name, data_type, is_nullable, character_maximum_length, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'users'`,
    );
    const columns = Object.fromEntries(rows.map((row) => [row.column_name, row]));

    expect(Object.keys(columns).sort()).toEqual([
      'created_at',
      'deleted_at',
      'email',
      'id',
      'name',
      'updated_at',
    ]);
    expect(columns.id).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    expect(columns.id?.column_default).toMatch(/gen_random_uuid\(\)/);
    expect(columns.email).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(columns.name).toMatchObject({ data_type: 'character varying', is_nullable: 'NO' });
    expect(Number(columns.name?.character_maximum_length)).toBe(100);
    for (const name of ['created_at', 'updated_at']) {
      expect(columns[name]).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      });
      expect(columns[name]?.column_default).toMatch(/now\(\)/);
    }
    expect(columns.deleted_at).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    });
  });

  it(`creates the unique index ${INDEX_NAME} on lower(email) where deleted_at is null`, async () => {
    const { rows } = await ctx.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'users' and indexname = $1`,
      [INDEX_NAME],
    );

    expect(rows).toHaveLength(1);
    const definition = rows[0]?.indexdef ?? '';
    expect(definition).toMatch(/^CREATE UNIQUE INDEX /);
    expect(definition).toMatch(/\(lower\(\(?email\)?\)\)/);
    expect(definition).toMatch(/WHERE \(deleted_at IS NULL\)$/);
  });

  it('rejects a direct second insert of an active email that differs only in letter case', async () => {
    await insertUser(ctx.db, { email: 'Ann@Example.com', name: 'Ann' });

    const error = await pgErrorOf(
      ctx.db.insert(users).values({ email: 'ann@example.COM', name: 'Other Ann' }),
    );

    expect(error).toMatchObject({ code: '23505', constraint: INDEX_NAME });
    expect(await ctx.db.select().from(users)).toHaveLength(1);
  });

  it('rejects a direct update that gives an active user the email of another active user', async () => {
    await insertUser(ctx.db, { email: 'Ann@Example.com' });
    await insertUser(ctx.db, { email: 'bob@example.com' });

    const error = await pgErrorOf(
      ctx.client.query(
        `update users set email = 'ANN@example.com' where email = 'bob@example.com'`,
      ),
    );

    expect(error).toMatchObject({ code: '23505', constraint: INDEX_NAME });
  });

  it('allows the same email on any number of soft-deleted rows plus one active row', async () => {
    await insertUsers(ctx.db, [
      { email: 'Ann@Example.com', deletedAt: LONG_AGO },
      { email: 'ann@example.com', deletedAt: LONG_AGO },
      { email: 'ANN@EXAMPLE.COM' },
    ]);

    expect(await ctx.db.select().from(users)).toHaveLength(3);
    const error = await pgErrorOf(
      ctx.db.insert(users).values({ email: 'aNN@example.com', name: 'Second active' }),
    );
    expect(error).toMatchObject({ code: '23505', constraint: INDEX_NAME });
  });
});

describe('users table (src/db/schema.ts)', () => {
  it(`declares the partial unique index ${INDEX_NAME}`, () => {
    const index = getTableConfig(users).indexes.find(
      (candidate) => candidate.config.name === INDEX_NAME,
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
  });
});
