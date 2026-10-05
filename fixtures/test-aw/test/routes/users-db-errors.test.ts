import { describe, expect, it } from 'vitest';
import {
  allUserRows,
  expectServerError,
  findUserRow,
  insertUser,
  newUserInput,
} from '../helpers/users.js';
import { createUser, ctx, patchUser, useFreshApp } from '../helpers/users-routes.js';

// These tests close the connection or add constraints, so they never share a database.
useFreshApp({ ownDatabase: true });

describe('database errors other than the email unique violation', () => {
  // Extra constraints are added to this test's own database (a fresh copy per test), so the
  // INSERT/UPDATE fails in Postgres with an error that is not a 23505 on users_email_active_unique.
  const addUniqueIndexOnName = () =>
    ctx.client.exec('create unique index users_name_test_unique on users (name)');
  const addCheckOnName = () =>
    ctx.client.exec(
      "alter table users add constraint users_name_test_check check (name <> 'Forbidden')",
    );

  it('POST /users returns 500, not 409, when the database is unavailable', async () => {
    await ctx.client.close();

    expectServerError(await createUser(newUserInput()));
  });

  it('PATCH /users/:id returns 500, not 409, when the database is unavailable', async () => {
    const ann = await insertUser(ctx.db);
    await ctx.client.close();

    expectServerError(await patchUser(ann.id, { email: 'annie@example.com', name: 'Annie' }));
  });

  it('POST /users returns 500, not 409, for a unique violation on another index (23505 on a different constraint)', async () => {
    await addUniqueIndexOnName();
    await insertUser(ctx.db, { email: 'ann@example.com', name: 'Ann' });

    const res = await createUser({ email: 'other@example.com', name: 'Ann' });

    expectServerError(res);
    expect(await allUserRows(ctx.db)).toHaveLength(1);
  });

  it('PATCH /users/:id returns 500, not 409, for a unique violation on another index (23505 on a different constraint)', async () => {
    await addUniqueIndexOnName();
    await insertUser(ctx.db, { email: 'ann@example.com', name: 'Ann' });
    const bob = await insertUser(ctx.db, { email: 'bob@example.com', name: 'Bob' });

    const res = await patchUser(bob.id, { email: 'robert@example.com', name: 'Ann' });

    expectServerError(res);
    expect(await findUserRow(ctx.db, bob.id)).toEqual(bob);
  });

  it('POST /users returns 500 for a constraint violation that is not a unique violation', async () => {
    await addCheckOnName();

    const res = await createUser({ email: 'ann@example.com', name: 'Forbidden' });

    expectServerError(res);
    expect(await allUserRows(ctx.db)).toHaveLength(0);
  });

  it('PATCH /users/:id returns 500 for a constraint violation that is not a unique violation', async () => {
    await addCheckOnName();
    const ann = await insertUser(ctx.db, { email: 'ann@example.com', name: 'Ann' });

    const res = await patchUser(ann.id, { email: 'annie@example.com', name: 'Forbidden' });

    expectServerError(res);
    expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
  });
});
